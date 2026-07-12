package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

data class ActivateBotRequest(
    val coinId: String,
    val strategy: String,
)

data class BotStatusResponse(
    val isActive: Boolean,
    val coinId: String?,
    val strategy: String?,
)

interface TradingBotService {
    @POST("/api/trading-bot/activate")
    suspend fun activate(@Body request: ActivateBotRequest): Response<Map<String, Any>>

    @GET("/api/trading-bot/status")
    suspend fun getStatus(): Response<BotStatusResponse>

    @POST("/api/trading-bot/execute-trade")
    suspend fun executeTrade(): Response<Map<String, Any>>

    @POST("/api/trading-bot/stop-trade")
    suspend fun stopTrade(): Response<Map<String, Any>>
}
