package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Headers

data class MarketCandidateDto(
    val rank: Int,
    val symbol: String,
    val currentMarketPrice: Double,
    val volume24h: Double,
    val priceChangePercent24h: Double,
    val score: Int,
)

interface MarketService {
    @GET("/api/market/candidates")
    @Headers("Content-Type: application/json")
    suspend fun getCandidates(): Response<List<MarketCandidateDto>>
}
