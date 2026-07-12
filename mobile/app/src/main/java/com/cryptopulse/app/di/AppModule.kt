package com.cryptopulse.app.di

import android.content.Context
import com.cryptopulse.app.data.api.AuthService
import com.cryptopulse.app.data.api.ExchangeService
import com.cryptopulse.app.data.api.MarketService
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.repository.AuthRepository
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideTokenManager(@ApplicationContext context: Context): TokenManager {
        return TokenManager(context)
    }

    private class AuthInterceptor(private val tokenManager: TokenManager) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val token = tokenManager.tokenFlow.value
            val requestBuilder = chain.request().newBuilder()
            if (!token.isNullOrEmpty()) {
                requestBuilder.addHeader("Authorization", "Bearer $token")
            }
            return chain.proceed(requestBuilder.build())
        }
    }

    @Provides
    @Singleton
    fun provideOkHttpClient(tokenManager: TokenManager): OkHttpClient {
        return OkHttpClient.Builder()
            .addInterceptor(AuthInterceptor(tokenManager))
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
}
