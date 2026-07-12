package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Query

data class TickerResponse(
    val symbol: String,
    val price: Double,
    val volume24h: Double,
    val priceChange24h: Double,
    val priceChangePercent24h: Double,
    val highPrice24h: Double,
    val lowPrice24h: Double,
    val minNotional: Double,
    val timestamp: String,
)

interface TickerService {
    @GET("/api/market/ticker")
    suspend fun getTicker(@Query("symbol") symbol: String): Response<TickerResponse>
}
