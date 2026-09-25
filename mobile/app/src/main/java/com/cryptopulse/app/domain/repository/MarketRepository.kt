package com.cryptopulse.app.domain.repository

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*

interface MarketRepository {
    suspend fun getCandidates(budget: Double): NetworkResult<List<MarketCandidate>>
    suspend fun getCandidates(): NetworkResult<List<MarketCandidate>> = getCandidates(50.0)
    suspend fun getKlines(symbol: String, interval: String, limit: Int): NetworkResult<List<Kline>>
    suspend fun getTicker(symbol: String): NetworkResult<Ticker>
}
