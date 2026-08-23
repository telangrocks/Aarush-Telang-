package com.cryptopulse.app.domain.repository

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*
import kotlinx.coroutines.flow.StateFlow

interface BotRepository {
    val analysisState: StateFlow<AnalysisSnapshot?>
    val isConnected: StateFlow<Boolean>

    suspend fun activateBot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit>
    suspend fun deactivateBot(): NetworkResult<Unit>
    suspend fun getStatus(): NetworkResult<BotStatus>
    suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult>
    suspend fun executeMockTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto): NetworkResult<TradeExecutionResult>
    suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult>
    fun pollExecutionStatus(positionId: String, timeoutMs: Long = 30_000L, pollIntervalMs: Long = 1500L): kotlinx.coroutines.flow.Flow<TradeExecutionResult>
    suspend fun stopTrade(): NetworkResult<Unit>
    suspend fun getAlerts(): NetworkResult<List<BotAlert>>
    suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit>

    fun updateAnalysisState(snapshot: AnalysisSnapshot?)
    fun updateConnectionState(connected: Boolean)
    fun startObserving()
    fun stopObserving()
}
