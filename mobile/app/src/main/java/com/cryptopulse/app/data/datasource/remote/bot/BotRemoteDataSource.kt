package com.cryptopulse.app.data.datasource.remote.bot

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.network.safeApiCall
import com.cryptopulse.app.data.api.TradingBotService
import com.cryptopulse.app.data.api.dto.bot.request.*
import com.cryptopulse.app.data.api.dto.bot.response.*
import javax.inject.Inject

interface BotRemoteDataSource {
    suspend fun activate(request: ActivateBotRequestDto): NetworkResult<ActivateBotResponseDto>
    suspend fun deactivate(): NetworkResult<ActivateBotResponseDto>
    suspend fun getStatus(): NetworkResult<BotStatusResponseDto>
    suspend fun getAnalysisStatus(): NetworkResult<AnalysisSnapshotDto>
    suspend fun executeTrade(alertId: String): NetworkResult<ExecuteTradeResponseDto>
    suspend fun executeMockTrade(): NetworkResult<ExecuteTradeResponseDto>
    suspend fun stopTrade(): NetworkResult<StopTradeResponseDto>
    suspend fun getAlerts(): NetworkResult<List<BotAlertDto>>
    suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto): NetworkResult<AcknowledgeAlertResponseDto>
}

class RetrofitBotRemoteDataSource @Inject constructor(
    private val tradingBotService: TradingBotService
) : BotRemoteDataSource {
    override suspend fun activate(request: ActivateBotRequestDto): NetworkResult<ActivateBotResponseDto> =
        safeApiCall { tradingBotService.activate(request) }

    override suspend fun deactivate(): NetworkResult<ActivateBotResponseDto> =
        safeApiCall { tradingBotService.deactivate() }

    override suspend fun getStatus(): NetworkResult<BotStatusResponseDto> =
        safeApiCall { tradingBotService.getStatus() }

    override suspend fun getAnalysisStatus(): NetworkResult<AnalysisSnapshotDto> =
        safeApiCall { tradingBotService.getAnalysisStatus() }

    override suspend fun executeTrade(alertId: String): NetworkResult<ExecuteTradeResponseDto> =
        safeApiCall { tradingBotService.executeTrade(ExecuteTradeRequestDto(alertId)) }

    override suspend fun executeMockTrade(): NetworkResult<ExecuteTradeResponseDto> =
        safeApiCall { tradingBotService.executeMockTrade() }

    override suspend fun stopTrade(): NetworkResult<StopTradeResponseDto> =
        safeApiCall { tradingBotService.stopTrade() }

    override suspend fun getAlerts(): NetworkResult<List<BotAlertDto>> =
        safeApiCall { tradingBotService.getAlerts() }

    override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto): NetworkResult<AcknowledgeAlertResponseDto> =
        safeApiCall { tradingBotService.acknowledgeAlert(request) }
}
