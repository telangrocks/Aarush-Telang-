package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.datasource.remote.market.MarketRemoteDataSource
import com.cryptopulse.app.data.mapper.market.toDomain
import com.cryptopulse.app.domain.models.MarketCandidate
import com.cryptopulse.app.domain.models.Kline
import com.cryptopulse.app.domain.models.Ticker
import com.cryptopulse.app.domain.repository.MarketRepository
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class MarketRepositoryImpl @Inject constructor(
    private val marketRemoteDataSource: MarketRemoteDataSource,
    private val dispatcherProvider: DispatcherProvider
) : MarketRepository {

    override suspend fun getCandidates(): NetworkResult<List<MarketCandidate>> = withContext(dispatcherProvider.io) {
        when (val result = marketRemoteDataSource.getMarketCandidates()) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.map { it.toDomain() })
            is NetworkResult.Error -> result
        }
    }

    override suspend fun getKlines(symbol: String, interval: String, limit: Int): NetworkResult<List<Kline>> = withContext(dispatcherProvider.io) {
        when (val result = marketRemoteDataSource.getKlines(symbol, interval, limit)) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.map { it.toDomain() })
            is NetworkResult.Error -> result
        }
    }

    override suspend fun getTicker(symbol: String): NetworkResult<Ticker> = withContext(dispatcherProvider.io) {
        when (val result = marketRemoteDataSource.getTicker(symbol)) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.toDomain())
            is NetworkResult.Error -> result
        }
    }
}
