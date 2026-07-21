package com.cryptopulse.app.data.repository

import com.cryptopulse.app.domain.models.TradeSetupConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

interface TradeSessionRepository {
    val selectedStrategyId: StateFlow<String?>
    val tradeSetupConfig: StateFlow<TradeSetupConfig?>

    fun setStrategyId(id: String)
    fun setTradeSetupConfig(config: TradeSetupConfig)
    fun clearSession()
}

@Singleton
class TradeSessionRepositoryImpl @Inject constructor() : TradeSessionRepository {
    
    private val _selectedStrategyId = MutableStateFlow<String?>(null)
    override val selectedStrategyId: StateFlow<String?> = _selectedStrategyId.asStateFlow()

    private val _tradeSetupConfig = MutableStateFlow<TradeSetupConfig?>(null)
    override val tradeSetupConfig: StateFlow<TradeSetupConfig?> = _tradeSetupConfig.asStateFlow()

    override fun setStrategyId(id: String) {
        _selectedStrategyId.value = id
    }

    override fun setTradeSetupConfig(config: TradeSetupConfig) {
        _tradeSetupConfig.value = config
    }

    override fun clearSession() {
        _selectedStrategyId.value = null
        _tradeSetupConfig.value = null
    }
}
