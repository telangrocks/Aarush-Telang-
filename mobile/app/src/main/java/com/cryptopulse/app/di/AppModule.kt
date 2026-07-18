package com.cryptopulse.app.di

import android.content.Context
import com.cryptopulse.app.data.api.AuthService
import com.cryptopulse.app.data.api.ExchangeService
import com.cryptopulse.app.data.api.FcmApi
import com.cryptopulse.app.data.api.KlineService
import com.cryptopulse.app.data.api.MarketService
import com.cryptopulse.app.data.api.StrategyService
import com.cryptopulse.app.data.api.TechnicalAnalysisService
import com.cryptopulse.app.data.api.TickerService
import com.cryptopulse.app.data.api.TradingBotService
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.data.repository.AuthRepository
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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
        private val authRepository: AuthRepository
    ) : Interceptor {
        private val refreshScope = CoroutineScope(Dispatchers.IO + kotlinx.coroutines.SupervisorJob())
        private var isRefreshing = false
        private val MAX_REFRESH_ATTEMPTS = 1

        override fun intercept(chain: Interceptor.Chain): Response {
            var token = tokenManager.tokenFlow.value
            var requestBuilder = chain.request().newBuilder()

            if (!token.isNullOrEmpty()) {
                requestBuilder.addHeader("Authorization", "Bearer $token")
            }

            var response = chain.proceed(requestBuilder.build())

            if (response.code == 401 && !token.isNullOrEmpty()) {
                response.close()
                synchronized(this) {
                    if (!isRefreshing) {
                        isRefreshing = true
                        try {
                            var attempts = 0
                            var refreshSuccess = false
                            while (attempts < MAX_REFRESH_ATTEMPTS && !refreshSuccess) {
                                attempts++
                                val refreshed = refreshScope.launch {
                                    val result = authRepository.refreshToken()
                                    if (result.isSuccess) {
                                        val newToken = tokenManager.tokenFlow.first()
                                        if (!newToken.isNullOrEmpty()) {
                                            val newRequest = chain.request().newBuilder()
                                                .addHeader("Authorization", "Bearer $newToken")
                                                .build()
                                            response = chain.proceed(newRequest)
                                            refreshSuccess = true
                                        }
                                    }
                                }
                                refreshed.join()
                                if (!refreshSuccess && attempts < MAX_REFRESH_ATTEMPTS) {
                                    delay(500)
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
            var response: Response? = null
            var lastException: IOException? = null

            while (retryCount < MAX_RETRIES) {
                try {
                    response = chain.proceed(chain.request())
                    if (response.isSuccessful) {
                        return response
                    }
                    response.close()
                } catch (e: IOException) {
                    lastException = e
                }
                retryCount++
                if (retryCount < MAX_RETRIES) {
                    try {
                        delay(INITIAL_DELAY_MS * retryCount)
                    } catch (e: InterruptedException) {
                        Thread.currentThread().interrupt()
                        throw e
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
        authRepository: AuthRepository
    ): OkHttpClient {
        return OkHttpClient.Builder()
            .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .addInterceptor(AuthInterceptor(tokenManager, authRepository))
            .addInterceptor(RetryInterceptor())
            .build()
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
    fun provideAuthRepository(api: AuthService, tokenManager: TokenManager): AuthRepository {
        return AuthRepository(api, tokenManager)
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
    fun provideStrategyService(retrofit: Retrofit): StrategyService {
        return retrofit.create(StrategyService::class.java)
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
