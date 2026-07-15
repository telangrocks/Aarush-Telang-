package com.cryptopulse.app.data.api

import com.google.gson.annotations.SerializedName
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Headers

data class MarketCandidateDto(
    val rank: Int,
    val symbol: String,
    @SerializedName("price") val currentMarketPrice: Double,
    val volume24h: Double,
    val quoteVolume24h: Double,
    val priceChange24h: Double,
    val priceChangePercent24h: Double,
    val score: Double,
    val minNotional: Double,
)

interface MarketService {
    @GET("/api/market/candidates")
    @Headers("Content-Type: application/json")
    suspend fun getCandidates(): Response<List<MarketCandidateDto>>
}
