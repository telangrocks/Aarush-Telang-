package com.cryptopulse.app.domain.repository

import com.cryptopulse.app.domain.models.TradeSetupConfig
import kotlinx.coroutines.flow.StateFlow

interface TradeSessionRepository {
    val selectedStrategyId: StateFlow<String?>
    val tradeSetupConfig: StateFlow<TradeSetupConfig?>

    fun setStrategyId(id: String)
    fun setTradeSetupConfig(config: TradeSetupConfig)
    fun clearSession()
}
