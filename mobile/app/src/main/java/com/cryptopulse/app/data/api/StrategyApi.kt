package com.cryptopulse.app.data.api

import com.cryptopulse.app.data.api.dto.strategy.response.StrategyDiscoveryResponseDto
import retrofit2.Response
import retrofit2.http.GET

interface StrategyApi {
    @GET("/api/strategies")
    suspend fun getAvailableStrategies(): Response<StrategyDiscoveryResponseDto>
}
