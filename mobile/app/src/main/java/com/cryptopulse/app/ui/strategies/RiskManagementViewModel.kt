package com.cryptopulse.app.ui.strategies

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.core.network.*
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
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
    private val sessionRepository: TradeSessionRepository,
    private val strategyRepository: com.cryptopulse.app.domain.repository.StrategyRepository
) : ViewModel() {
    private val _state = MutableStateFlow(RiskManagementState())
    val state: StateFlow<RiskManagementState> = _state.asStateFlow()

    fun initialize(strategy: Strategy? = null) {
        val config = sessionRepository.tradeSetupConfig.value
        val stratId = strategy?.id ?: sessionRepository.selectedStrategyId.value ?: config?.strategyId ?: "ScalperV2"
        val existingRiskParams = config?.riskParameters ?: emptyMap()
        val defaults = strategy?.defaultRiskParameters ?: emptyMap()

        _state.update {
            it.copy(
                selectedStrategy = strategy,
                tradeSetupConfig = config,
                accountRiskPercent = existingRiskParams["accountRiskPercent"] ?: defaults["accountRiskPercent"] ?: 1.0,
                riskRewardRatio = existingRiskParams["riskRewardRatio"] ?: defaults["riskRewardRatio"] ?: 2.0,
                atrStopLossMultiplier = existingRiskParams["atrStopLossMultiplier"] ?: defaults["atrStopLossMultiplier"] ?: 1.5
            )
        }

        if (strategy == null) {
            viewModelScope.launch {
                when (val res = strategyRepository.getStrategies()) {
                    is NetworkResult.Success -> {
                        val found = res.data.find { it.id.equals(stratId, ignoreCase = true) }
                        if (found != null) {
                            val stratDefaults = found.defaultRiskParameters
                            _state.update { current ->
                                current.copy(
                                    selectedStrategy = found,
                                    accountRiskPercent = current.accountRiskPercent ?: stratDefaults["accountRiskPercent"] ?: 1.0,
                                    riskRewardRatio = current.riskRewardRatio ?: stratDefaults["riskRewardRatio"] ?: 2.0,
                                    atrStopLossMultiplier = current.atrStopLossMultiplier ?: stratDefaults["atrStopLossMultiplier"] ?: 1.5
                                )
                            }
                        }
                    }
                    is NetworkResult.Error -> {}
                }
            }
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
    
    fun getUpdatedConfig(): TradeSetupConfig {
        val stratId = _state.value.selectedStrategy?.id 
            ?: sessionRepository.selectedStrategyId.value 
            ?: _state.value.tradeSetupConfig?.strategyId 
            ?: "ScalperV2"

        val currentConfig = _state.value.tradeSetupConfig 
            ?: sessionRepository.tradeSetupConfig.value 
            ?: TradeSetupConfig(
                strategyId = stratId,
                symbol = "BTC",
                entryPrice = 0.0
            )

        val params = mutableMapOf<String, Double>()
        _state.value.accountRiskPercent?.let { params["accountRiskPercent"] = it }
        _state.value.riskRewardRatio?.let { params["riskRewardRatio"] = it }
        _state.value.atrStopLossMultiplier?.let { params["atrStopLossMultiplier"] = it }

        val updated = currentConfig.copy(
            strategyId = stratId,
            riskParameters = params
        )
        sessionRepository.setTradeSetupConfig(updated)
        return updated
    }
}
