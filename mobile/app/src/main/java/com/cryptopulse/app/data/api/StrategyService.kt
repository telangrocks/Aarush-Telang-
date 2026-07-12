package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

data class StrategyDto(
    val id: String,
    val name: String,
    val description: String,
)

interface StrategyService {
    @GET("/api/strategies")
    suspend fun getStrategies(): Response<List<StrategyDto>>
}
