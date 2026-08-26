package com.cryptopulse.app.ui.strategies

import androidx.lifecycle.ViewModel
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject

data class RiskManagementState(
    val selectedStrategy: Strategy? = null,
    val tradeSetupConfig: TradeSetupConfig? = null,
    val accountRiskPercent: Double? = null,
    val riskRewardRatio: Double? = null,
    val atrStopLossMultiplier: Double? = null
)

@HiltViewModel
class RiskManagementViewModel @Inject constructor(
    private val sessionRepository: TradeSessionRepository
) : ViewModel() {
    private val _state = MutableStateFlow(RiskManagementState())
    val state: StateFlow<RiskManagementState> = _state.asStateFlow()

    fun initialize(strategy: Strategy? = null) {
        val config = sessionRepository.tradeSetupConfig.value
        val defaults = strategy?.defaultRiskParameters ?: emptyMap()
        _state.update {
            it.copy(
                selectedStrategy = strategy,
                tradeSetupConfig = config,
                accountRiskPercent = defaults["accountRiskPercent"] ?: 1.0,
                riskRewardRatio = defaults["riskRewardRatio"] ?: 2.0,
                atrStopLossMultiplier = defaults["atrStopLossMultiplier"] ?: 1.5
            )
        }
    }

    fun updateAccountRisk(value: Double) {
        val clamped = value.coerceIn(0.1, 5.0)
        _state.update { it.copy(accountRiskPercent = clamped) }
    }

    fun updateRiskReward(value: Double) {
        val clamped = value.coerceIn(1.0, 5.0)
        _state.update { it.copy(riskRewardRatio = clamped) }
    }

    fun updateAtrStopLoss(value: Double) {
        val clamped = value.coerceIn(0.5, 5.0)
        _state.update { it.copy(atrStopLossMultiplier = clamped) }
    }
    
    fun getUpdatedConfig(): TradeSetupConfig? {
        val currentConfig = _state.value.tradeSetupConfig ?: return null
        val params = mutableMapOf<String, Double>()
        _state.value.accountRiskPercent?.let { params["accountRiskPercent"] = it }
        _state.value.riskRewardRatio?.let { params["riskRewardRatio"] = it }
        _state.value.atrStopLossMultiplier?.let { params["atrStopLossMultiplier"] = it }
        return currentConfig.copy(riskParameters = params)
    }
}
