package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

data class ActivateBotRequest(
    val coinId: String,
    val strategy: String,
)

data class BotStatusResponse(
    val isActive: Boolean,
    val coinId: String?,
    val strategy: String?,
)

data class PositionResponse(
    val id: String,
    val userId: String,
    val symbol: String,
    val side: String,
    val entryPrice: Double,
    val quantity: Double,
    val stopLoss: Double,
    val takeProfit: Double,
    val status: String,
    val exchange: String,
    val environment: String,
    val strategy: String?,
    val orderId: String?,
    val entryAt: String?,
    val closedAt: String?,
    val closePrice: Double?,
    val realizedPnl: Double?,
    val closeReason: String?,
    val createdAt: String?,
    val updatedAt: String?,
    val currentPrice: Double?,
    val livePnl: Double?,
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

    @GET("/api/trading-bot/alerts")
    suspend fun getAlerts(): Response<List<Map<String, Any>>>

    @POST("/api/trading-bot/alerts/acknowledge")
    suspend fun acknowledgeAlert(@Body request: Map<String, String>): Response<Map<String, Any>>

    @GET("/api/positions")
    suspend fun getPositions(): Response<List<PositionResponse>>

    @POST("/api/positions/{id}/close")
    suspend fun closePosition(@Path("id") positionId: String): Response<Map<String, Any>>
}
