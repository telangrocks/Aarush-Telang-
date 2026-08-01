package com.cryptopulse.app.data.datasource.remote.market

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.network.safeApiCall
import com.cryptopulse.app.data.api.MarketService
import com.cryptopulse.app.data.api.KlineService
import com.cryptopulse.app.data.api.TickerService
import com.cryptopulse.app.data.api.dto.market.response.*
import javax.inject.Inject

interface MarketRemoteDataSource {
    suspend fun getMarketCandidates(): NetworkResult<List<MarketCandidateDto>>
    suspend fun getKlines(symbol: String, interval: String, limit: Int): NetworkResult<List<KlineDto>>
    suspend fun getTicker(symbol: String): NetworkResult<TickerResponseDto>
}

class RetrofitMarketRemoteDataSource @Inject constructor(
    private val marketService: MarketService,
    private val klineService: KlineService,
    private val tickerService: TickerService
) : MarketRemoteDataSource {
    override suspend fun getMarketCandidates(): NetworkResult<List<MarketCandidateDto>> =
        safeApiCall { marketService.getMarketCandidates() }

    override suspend fun getKlines(symbol: String, interval: String, limit: Int): NetworkResult<List<KlineDto>> =
        safeApiCall { klineService.getKlines(symbol, interval, limit) }

    override suspend fun getTicker(symbol: String): NetworkResult<TickerResponseDto> =
        safeApiCall { tickerService.getTicker(symbol) }
}
