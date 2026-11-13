package com.cryptopulse.app.domain.repository

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*
import kotlinx.coroutines.flow.StateFlow

interface BotRepository {
    val analysisState: StateFlow<AnalysisSnapshot?>
    val activeBotAnalysisState: StateFlow<AnalysisSnapshot?>
    val committedStrategyId: StateFlow<String?>
    val isBotActive: StateFlow<Boolean>
    val isConnected: StateFlow<Boolean>

    suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit>
    suspend fun activateBot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> =
        if (symbol.isBlank()) {
            NetworkResult.Error(
                com.cryptopulse.app.core.error.NetworkError.HttpError(
                    code = 400,
                    message = "Cannot activate bot: symbol is blank.",
                    detail = "Symbol is blank"
                )
            )
        } else {
            activateBot(listOf(symbol), strategy, config)
        }
    suspend fun deactivateBot(): NetworkResult<Unit>
    suspend fun getStatus(): NetworkResult<BotStatus>
    suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult>
    suspend fun executeTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto): NetworkResult<TradeExecutionResult> =
        executeTrade(request.alertId)
    suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult>
    fun pollExecutionStatus(positionId: String, timeoutMs: Long = 30_000L, pollIntervalMs: Long = 1500L): kotlinx.coroutines.flow.Flow<TradeExecutionResult>
    suspend fun stopTrade(): NetworkResult<Unit>
    suspend fun getAlerts(): NetworkResult<List<BotAlert>>
    suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit>
    suspend fun dismissAlert(alertId: String): NetworkResult<Unit>

    fun updateAnalysisState(snapshot: AnalysisSnapshot?)
    fun updateConnectionState(connected: Boolean)
    fun startObserving()
    fun stopObserving()
}
