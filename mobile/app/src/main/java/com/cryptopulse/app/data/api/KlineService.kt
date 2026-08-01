package com.cryptopulse.app.data.api

import com.cryptopulse.app.data.api.dto.market.response.KlineDto
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Query

interface KlineService {
    @GET(ApiConstants.MARKET_KLINES)
    suspend fun getKlines(
        @Query("symbol") symbol: String,
        @Query("interval") interval: String,
        @Query("limit") limit: Int = 100
    ): Response<List<KlineDto>>
}
