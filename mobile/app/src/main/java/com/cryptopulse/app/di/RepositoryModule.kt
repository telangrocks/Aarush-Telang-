package com.cryptopulse.app.di

import com.cryptopulse.app.data.repository.StrategyRepository
import com.cryptopulse.app.data.repository.StrategyRepositoryImpl
import com.cryptopulse.app.data.repository.TradeSessionRepository
import com.cryptopulse.app.data.repository.TradeSessionRepositoryImpl
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
    abstract fun bindStrategyRepository(
        strategyRepositoryImpl: StrategyRepositoryImpl
    ): StrategyRepository

    @Binds
    @Singleton
    abstract fun bindTradeSessionRepository(
        tradeSessionRepositoryImpl: TradeSessionRepositoryImpl
    ): TradeSessionRepository
}
