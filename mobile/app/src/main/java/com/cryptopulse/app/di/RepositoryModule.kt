package com.cryptopulse.app.di

import com.cryptopulse.app.data.datasource.remote.auth.*
import com.cryptopulse.app.data.datasource.remote.bot.*
import com.cryptopulse.app.data.datasource.remote.exchange.*
import com.cryptopulse.app.data.datasource.remote.fcm.*
import com.cryptopulse.app.data.datasource.remote.market.*
import com.cryptopulse.app.data.datasource.remote.technicalanalysis.*
import com.cryptopulse.app.data.datasource.remote.strategy.*
import com.cryptopulse.app.data.repository.*
import com.cryptopulse.app.domain.repository.*
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class RepositoryModule {

    @Binds
    @Singleton
    abstract fun bindStrategyRemoteDataSource(impl: RetrofitStrategyRemoteDataSource): StrategyRemoteDataSource

    @Binds
    @Singleton
    abstract fun bindAuthRemoteDataSource(impl: RetrofitAuthRemoteDataSource): AuthRemoteDataSource

    @Binds
    @Singleton
    abstract fun bindBotRemoteDataSource(impl: RetrofitBotRemoteDataSource): BotRemoteDataSource

    @Binds
    @Singleton
    abstract fun bindExchangeRemoteDataSource(impl: RetrofitExchangeRemoteDataSource): ExchangeRemoteDataSource

    @Binds
    @Singleton
    abstract fun bindFcmRemoteDataSource(impl: RetrofitFcmRemoteDataSource): FcmRemoteDataSource

    @Binds
    @Singleton
    abstract fun bindMarketRemoteDataSource(impl: RetrofitMarketRemoteDataSource): MarketRemoteDataSource

    @Binds
    @Singleton
    abstract fun bindTechnicalAnalysisRemoteDataSource(impl: RetrofitTechnicalAnalysisRemoteDataSource): TechnicalAnalysisRemoteDataSource

    @Binds
    @Singleton
    abstract fun bindAuthRepository(impl: AuthRepositoryImpl): AuthRepository

    @Binds
    @Singleton
    abstract fun bindBotRepository(impl: BotRepositoryImpl): BotRepository

    @Binds
    @Singleton
    abstract fun bindExchangeRepository(impl: ExchangeRepositoryImpl): ExchangeRepository

    @Binds
    @Singleton
    abstract fun bindFcmRepository(impl: FcmRepositoryImpl): FcmRepository

    @Binds
    @Singleton
    abstract fun bindMarketRepository(impl: MarketRepositoryImpl): MarketRepository

    @Binds
    @Singleton
    abstract fun bindTechnicalAnalysisRepository(impl: TechnicalAnalysisRepositoryImpl): TechnicalAnalysisRepository

    @Binds
    @Singleton
    abstract fun bindStrategyRepository(impl: StrategyRepositoryImpl): StrategyRepository

    @Binds
    @Singleton
    abstract fun bindTradeSessionRepository(impl: TradeSessionRepositoryImpl): TradeSessionRepository
}

