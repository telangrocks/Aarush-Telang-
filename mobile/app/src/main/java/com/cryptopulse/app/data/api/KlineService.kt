package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Query

data class KlineDto(
    val openTime: Long,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
    val volume: Double,
    val closeTime: Long,
)

interface KlineService {
    @GET("/api/market/klines")
    suspend fun getKlines(
        @Query("symbol") symbol: String,
        @Query("interval") interval: String = "1h",
        @Query("limit") limit: Int = 100,
    ): Response<List<KlineDto>>
}
