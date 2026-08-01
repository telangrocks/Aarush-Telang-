package com.cryptopulse.app.data.api

import com.cryptopulse.app.data.api.dto.market.response.TickerResponseDto
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Query

interface TickerService {
    @GET(ApiConstants.MARKET_TICKER)
    suspend fun getTicker(
        @Query("symbol") symbol: String
    ): Response<TickerResponseDto>
}
