package com.cryptopulse.app.di

import com.cryptopulse.app.data.api.StrategyApi
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BODY
        }
        return OkHttpClient.Builder()
            .addInterceptor(logging)
            .build()
    }

    @Provides
    @Singleton
    fun provideRetrofit(okHttpClient: OkHttpClient): Retrofit {
        return Retrofit.Builder()
            .baseUrl("http://10.0.2.2:8787/") // Localhost for emulator hitting wrangler
            .client(okHttpClient)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
    }

    @Provides
    @Singleton
    fun provideStrategyApi(retrofit: Retrofit): StrategyApi {
        return retrofit.create(StrategyApi::class.java)
    }

    @Provides
    @Singleton
    fun provideAnalysisApi(retrofit: Retrofit): com.cryptopulse.app.data.api.AnalysisApi {
        return retrofit.create(com.cryptopulse.app.data.api.AnalysisApi::class.java)
    }
}
