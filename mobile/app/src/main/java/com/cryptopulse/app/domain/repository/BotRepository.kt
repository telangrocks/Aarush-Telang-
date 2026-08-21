package com.cryptopulse.app.domain.repository

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*
import kotlinx.coroutines.flow.StateFlow

interface BotRepository {
    val analysisState: StateFlow<AnalysisSnapshot?>
    val isConnected: StateFlow<Boolean>

    suspend fun activateBot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit>
    suspend fun deactivateBot(): NetworkResult<Unit>
    suspend fun getStatus(): NetworkResult<BotState>
    suspend fun executeTrade(alertId: String): NetworkResult<Unit>
    suspend fun executeMockTrade(): NetworkResult<Unit>
    suspend fun stopTrade(): NetworkResult<Unit>
    suspend fun getAlerts(): NetworkResult<List<BotAlert>>
    suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit>

    fun updateAnalysisState(snapshot: AnalysisSnapshot?)
    fun updateConnectionState(connected: Boolean)
    fun startObserving()
    fun stopObserving()
}
