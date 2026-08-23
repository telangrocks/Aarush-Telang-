package com.cryptopulse.app.data.api

import com.cryptopulse.app.data.api.dto.bot.request.*
import com.cryptopulse.app.data.api.dto.bot.response.*
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface TradingBotService {
    @POST(ApiConstants.BOT_ACTIVATE)
    suspend fun activate(@Body request: ActivateBotRequestDto): Response<ActivateBotResponseDto>

    @POST(ApiConstants.BOT_DEACTIVATE)
    suspend fun deactivate(): Response<ActivateBotResponseDto>

    @GET(ApiConstants.BOT_STATUS)
    suspend fun getStatus(): Response<BotStatusResponseDto>

    @GET(ApiConstants.BOT_ANALYSIS_STATUS)
    suspend fun getAnalysisStatus(): Response<AnalysisSnapshotDto>

    @POST(ApiConstants.BOT_EXECUTE_TRADE)
    suspend fun executeTrade(@Body request: ExecuteTradeRequestDto): Response<ExecuteTradeResponseDto>

    @POST(ApiConstants.BOT_MOCK_TRADE)
    suspend fun executeMockTrade(@Body request: ExecuteTradeRequestDto): Response<ExecuteTradeResponseDto>

    @POST(ApiConstants.BOT_STOP_TRADE)
    suspend fun stopTrade(): Response<StopTradeResponseDto>

    @GET(ApiConstants.BOT_ALERTS)
    suspend fun getAlerts(): Response<List<BotAlertDto>>

    @POST(ApiConstants.BOT_ALERTS_ACKNOWLEDGE)
    suspend fun acknowledgeAlert(@Body request: AcknowledgeAlertRequestDto): Response<AcknowledgeAlertResponseDto>

    @GET(ApiConstants.BOT_EXECUTION_STATUS)
    suspend fun getExecutionStatus(@retrofit2.http.Path("positionId") positionId: String): Response<TradeExecutionStatusDto>
}
