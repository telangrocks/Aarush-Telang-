package com.cryptopulse.app.ui.strategies

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.domain.repository.StrategyRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class RiskManagementState(
    val selectedStrategy: Strategy? = null,
    val tradeSetupConfig: TradeSetupConfig? = null,
    val accountRiskPercent: Double = 1.0,
    val atrTakeProfitMultiplier: Double = 2.0,
    val atrStopLossMultiplier: Double = 1.5
) {
    @Deprecated("Use atrTakeProfitMultiplier under Model A", ReplaceWith("atrTakeProfitMultiplier"))
    val riskRewardRatio: Double get() = atrTakeProfitMultiplier
}

@HiltViewModel
class RiskManagementViewModel @Inject constructor(
    private val sessionRepository: TradeSessionRepository,
    private val strategyRepository: StrategyRepository
) : ViewModel() {

    private val _state = MutableStateFlow(RiskManagementState())
    val state: StateFlow<RiskManagementState> = _state.asStateFlow()

    fun initialize(strategy: Strategy? = null) {
        val config = sessionRepository.tradeSetupConfig.value
        val stratId = strategy?.id ?: sessionRepository.selectedStrategyId.value ?: config?.strategyId ?: "ScalperV2"
        val existingRiskParams = config?.riskParameters ?: emptyMap()
        val defaults = strategy?.defaultRiskParameters ?: emptyMap()

        val initialTp = existingRiskParams["atrTakeProfitMultiplier"]
            ?: existingRiskParams["riskRewardRatio"]
            ?: defaults["atrTakeProfitMultiplier"]
            ?: defaults["riskRewardRatio"]
            ?: 2.0

        _state.update {
            it.copy(
                selectedStrategy = strategy,
                tradeSetupConfig = config,
                accountRiskPercent = existingRiskParams["accountRiskPercent"] ?: defaults["accountRiskPercent"] ?: 1.0,
                atrTakeProfitMultiplier = initialTp,
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
                            val asyncTp = existingRiskParams["atrTakeProfitMultiplier"]
                                ?: existingRiskParams["riskRewardRatio"]
                                ?: stratDefaults["atrTakeProfitMultiplier"]
                                ?: stratDefaults["riskRewardRatio"]
                                ?: currentAtrTp(current = _state.value.atrTakeProfitMultiplier)
                            _state.update { current ->
                                current.copy(
                                    selectedStrategy = found,
                                    accountRiskPercent = existingRiskParams["accountRiskPercent"] ?: stratDefaults["accountRiskPercent"] ?: current.accountRiskPercent,
                                    atrTakeProfitMultiplier = asyncTp,
                                    atrStopLossMultiplier = existingRiskParams["atrStopLossMultiplier"] ?: stratDefaults["atrStopLossMultiplier"] ?: current.atrStopLossMultiplier
                                )
                            }
                        }
                    }
                    is NetworkResult.Error -> {}
                }
            }
        }
    }

    private fun currentAtrTp(current: Double): Double = current

    fun updateAccountRisk(value: Double) {
        val clamped = value.coerceIn(0.1, 5.0)
        _state.update { it.copy(accountRiskPercent = clamped) }
    }

    fun updateAtrTakeProfit(value: Double) {
        val clamped = value.coerceIn(1.0, 5.0)
        _state.update { it.copy(atrTakeProfitMultiplier = clamped) }
    }

    @Deprecated("Use updateAtrTakeProfit under Model A", ReplaceWith("updateAtrTakeProfit(value)"))
    fun updateRiskReward(value: Double) {
        updateAtrTakeProfit(value)
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
        params["accountRiskPercent"] = _state.value.accountRiskPercent
        params["atrTakeProfitMultiplier"] = _state.value.atrTakeProfitMultiplier
        params["riskRewardRatio"] = _state.value.atrTakeProfitMultiplier // Legacy mirror key for backward compatibility
        params["atrStopLossMultiplier"] = _state.value.atrStopLossMultiplier

        val updated = currentConfig.copy(
            strategyId = stratId,
            riskParameters = params
        )
        sessionRepository.setTradeSetupConfig(updated)
        return updated
    }
}
