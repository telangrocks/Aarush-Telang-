package com.cryptopulse.app.data.api

import com.cryptopulse.app.data.api.dto.market.response.MarketCandidateDto
import retrofit2.Response
import retrofit2.http.GET

interface MarketService {
    @GET(ApiConstants.MARKET_CANDIDATES)
    suspend fun getMarketCandidates(): Response<List<MarketCandidateDto>>
}
