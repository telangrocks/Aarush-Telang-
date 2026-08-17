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
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
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

    private class AuthInterceptor(
        private val tokenManager: TokenManager,
        private val authRepositoryLazy: Lazy<AuthRepository>
    ) : Interceptor {
        private var isRefreshing = false

        override fun intercept(chain: Interceptor.Chain): Response {
            val token = runBlocking { tokenManager.getToken() }
            val requestBuilder = chain.request().newBuilder()

            if (!token.isNullOrEmpty()) {
                requestBuilder.addHeader("Authorization", "Bearer $token")
            }

            var response = chain.proceed(requestBuilder.build())

            if (response.code == 401 && !token.isNullOrEmpty()) {
                synchronized(this) {
                    if (!isRefreshing) {
                        isRefreshing = true
                        try {
                            val result = runBlocking { authRepositoryLazy.get().refreshToken() }
                            if (result is NetworkResult.Success) {
                                val newToken = runBlocking { tokenManager.getToken() }
                                if (!newToken.isNullOrEmpty()) {
                                    val newRequest = chain.request().newBuilder()
                                        .removeHeader("Authorization")
                                        .addHeader("Authorization", "Bearer $newToken")
                                        .build()
                                    response.close()
                                    response = chain.proceed(newRequest)
                                }
                            }
                        } finally {
                            isRefreshing = false
                        }
                    }
                }
            }

            return response
        }
    }

    private class RetryInterceptor : Interceptor {
        private val MAX_RETRIES = 2
        private val INITIAL_DELAY_MS = 1000L

        override fun intercept(chain: Interceptor.Chain): Response {
            var retryCount = 0
            var lastException: IOException? = null

            while (retryCount < MAX_RETRIES) {
                try {
                    return chain.proceed(chain.request())
                } catch (e: IOException) {
                    lastException = e
                }
                retryCount++
                if (retryCount < MAX_RETRIES) {
                    try {
                        Thread.sleep(INITIAL_DELAY_MS * retryCount)
                    } catch (e: InterruptedException) {
                        Thread.currentThread().interrupt()
                        throw IOException("Retry interrupted", e)
                    }
                }
            }

            throw lastException ?: IOException("Unknown network error after $MAX_RETRIES retries")
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
            .addInterceptor(AuthInterceptor(tokenManager, authRepository))
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

