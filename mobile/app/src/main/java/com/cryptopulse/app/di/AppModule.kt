package com.cryptopulse.app.di

import android.content.Context
import com.cryptopulse.app.data.api.AuthService
import com.cryptopulse.app.data.api.ExchangeService
import com.cryptopulse.app.data.api.FcmApi
import com.cryptopulse.app.data.api.KlineService
import com.cryptopulse.app.data.api.MarketService
import com.cryptopulse.app.data.api.StrategyApi
import com.cryptopulse.app.data.api.TechnicalAnalysisService
import com.cryptopulse.app.data.api.TickerService
import com.cryptopulse.app.data.api.TradingBotService
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.domain.repository.AuthRepository
import com.cryptopulse.app.core.network.NetworkResult
import dagger.Lazy
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.runBlocking
import android.util.Log
import com.cryptopulse.app.BuildConfig
import okhttp3.logging.HttpLoggingInterceptor
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.io.IOException
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideTokenManager(@ApplicationContext context: Context): TokenManager {
        return TokenManager(context)
    }

    @Provides
    @Singleton
    fun provideExchangeConnectionManager(@ApplicationContext context: Context): ExchangeConnectionManager {
        return ExchangeConnectionManager(context)
    }

    internal class TokenAuthenticator(
        private val tokenManager: TokenManager,
        private val authRepositoryLazy: Lazy<AuthRepository>
    ) : Authenticator {
        private val lock = Any()

        override fun authenticate(route: Route?, response: Response): Request? {
            val path = response.request.url.encodedPath

            // 1. Never recursively authenticate public auth/refresh endpoints
            if (path.endsWith("/api/refresh") || path.endsWith("/api/login") || path.endsWith("/api/register")) {
                return null
            }

            // 2. Loop protection: do not retry more than 2 consecutive 401s for the same request
            if (responseCount(response) >= 2) {
                return null
            }

            val failedToken = response.request.header("Authorization")?.removePrefix("Bearer ")

            synchronized(lock) {
                val currentToken = runBlocking { tokenManager.getToken() }

                // 3. Double-checked locking: If another concurrent thread has already refreshed the token, reuse it!
                if (!currentToken.isNullOrEmpty() && currentToken != failedToken) {
                    return response.request.newBuilder()
                        .header("Authorization", "Bearer $currentToken")
                        .build()
                }

                // 4. Verify refresh token is present before requesting refresh
                val refreshToken = runBlocking { tokenManager.getRefreshToken() }
                if (refreshToken.isNullOrEmpty()) {
                    return null
                }

                // 5. Execute token refresh
                val refreshResult = runBlocking { authRepositoryLazy.get().refreshToken() }
                if (refreshResult is NetworkResult.Success) {
                    val newToken = runBlocking { tokenManager.getToken() }
                    if (!newToken.isNullOrEmpty()) {
                        return response.request.newBuilder()
                            .header("Authorization", "Bearer $newToken")
                            .build()
                    }
                }

                return null
            }
        }

        private fun responseCount(response: Response): Int {
            var count = 1
            var prior = response.priorResponse
            while (prior != null) {
                count++
                prior = prior.priorResponse
            }
            return count
        }
    }

    internal class AuthInterceptor(
        private val tokenManager: TokenManager
    ) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            val path = request.url.encodedPath

            // Do not attach Authorization header to public auth endpoints
            if (path.endsWith("/api/login") || path.endsWith("/api/register") || path.endsWith("/api/refresh")) {
                return chain.proceed(request)
            }

            val token = runBlocking { tokenManager.getToken() }
            val requestBuilder = request.newBuilder()

            if (!token.isNullOrEmpty()) {
                requestBuilder.header("Authorization", "Bearer $token")
            }

            return chain.proceed(requestBuilder.build())
        }
    }

    internal class RetryInterceptor : Interceptor {
        private val MAX_RETRIES = 2
        private val INITIAL_DELAY_MS = 1000L

        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            val method = request.method

            // Strictly enforce idempotent retry policy: NEVER retry POST/mutation requests
            if (method != "GET" && method != "HEAD") {
                return chain.proceed(request)
            }

            var retryCount = 0
            var lastException: IOException? = null

            while (retryCount <= MAX_RETRIES) {
                try {
                    val response = chain.proceed(request)
                    val code = response.code

                    // Check for retryable server errors and rate-limiting
                    if ((code == 502 || code == 503 || code == 504 || code == 429) && retryCount < MAX_RETRIES) {
                        val retryAfterHeader = response.header("Retry-After")
                        val delayMs = if (code == 429 && retryAfterHeader != null) {
                            (retryAfterHeader.toLongOrNull()?.times(1000L) ?: (INITIAL_DELAY_MS * (1L shl retryCount))).coerceIn(500L, 3000L)
                        } else {
                            INITIAL_DELAY_MS * (1L shl retryCount)
                        }

                        // Explicitly close failed response before retrying to prevent resource leaks
                        response.close()
                        retryCount++

                        try {
                            Thread.sleep(delayMs)
                        } catch (e: InterruptedException) {
                            Thread.currentThread().interrupt()
                            throw IOException("Request interrupted during retry backoff", e)
                        }
                        continue
                    }

                    return response
                } catch (e: IOException) {
                    lastException = e
                    if (retryCount < MAX_RETRIES) {
                        retryCount++
                        val delayMs = INITIAL_DELAY_MS * (1L shl (retryCount - 1))
                        try {
                            Thread.sleep(delayMs)
                        } catch (ie: InterruptedException) {
                            Thread.currentThread().interrupt()
                            throw IOException("Request interrupted during retry backoff", ie)
                        }
                    } else {
                        break
                    }
                }
            }

            throw lastException ?: IOException("Request failed after $MAX_RETRIES retries")
        }
    }

    @Provides
    @Singleton
    fun provideOkHttpClient(
        tokenManager: TokenManager,
        authRepository: Lazy<AuthRepository>
    ): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .authenticator(TokenAuthenticator(tokenManager, authRepository))
            .addInterceptor(AuthInterceptor(tokenManager))
            .addInterceptor(RetryInterceptor())

        if (BuildConfig.DEBUG) {
            val loggingInterceptor = HttpLoggingInterceptor { message ->
                val redacted = message
                    .replace(Regex("\"apiKey\"\\s*:\\s*\"[^\"]+\""), "\"apiKey\":\"[REDACTED]\"")
                    .replace(Regex("\"apiSecret\"\\s*:\\s*\"[^\"]+\""), "\"apiSecret\":\"[REDACTED]\"")
                    .replace(Regex("\"apiPassphrase\"\\s*:\\s*\"[^\"]+\""), "\"apiPassphrase\":\"[REDACTED]\"")
                    .replace(Regex("\"password\"\\s*:\\s*\"[^\"]+\""), "\"password\":\"[REDACTED]\"")
                    .replace(Regex("\"confirmPassword\"\\s*:\\s*\"[^\"]+\""), "\"confirmPassword\":\"[REDACTED]\"")
                    .replace(Regex("Authorization: Bearer \\S+"), "Authorization: Bearer [REDACTED]")
                    .replace(Regex("X-BAPI-API-KEY: \\S+"), "X-BAPI-API-KEY: [REDACTED]")
                    .replace(Regex("X-BAPI-SIGN: \\S+"), "X-BAPI-SIGN: [REDACTED]")
                Log.d("OkHttpDiagnostics", redacted)
            }.apply {
                level = HttpLoggingInterceptor.Level.BASIC
            }
            builder.addInterceptor(loggingInterceptor)
        }

        return builder.build()
    }

    @Provides
    @Singleton
    fun provideRetrofit(okHttpClient: OkHttpClient): Retrofit {
        return Retrofit.Builder()
            .baseUrl("https://crypto-pulse-backend.telangrocks.workers.dev/")
            .client(okHttpClient)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
    }

    @Provides
    @Singleton
    fun provideAuthService(retrofit: Retrofit): AuthService {
        return retrofit.create(AuthService::class.java)
    }


    @Provides
    @Singleton
    fun provideExchangeService(retrofit: Retrofit): ExchangeService {
        return retrofit.create(ExchangeService::class.java)
    }

    @Provides
    @Singleton
    fun provideMarketService(retrofit: Retrofit): MarketService {
        return retrofit.create(MarketService::class.java)
    }

    @Provides
    @Singleton
    fun provideStrategyApi(retrofit: Retrofit): StrategyApi {
        return retrofit.create(StrategyApi::class.java)
    }

    @Provides
    @Singleton
    fun provideTechnicalAnalysisService(retrofit: Retrofit): TechnicalAnalysisService {
        return retrofit.create(TechnicalAnalysisService::class.java)
    }

    @Provides
    @Singleton
    fun provideTickerService(retrofit: Retrofit): TickerService {
        return retrofit.create(TickerService::class.java)
    }

    @Provides
    @Singleton
    fun provideKlineService(retrofit: Retrofit): KlineService {
        return retrofit.create(KlineService::class.java)
    }

    @Provides
    @Singleton
    fun provideTradingBotService(retrofit: Retrofit): TradingBotService {
        return retrofit.create(TradingBotService::class.java)
    }

    @Provides
    @Singleton
    fun provideFcmApi(retrofit: Retrofit): FcmApi {
        return retrofit.create(FcmApi::class.java)
    }
}

