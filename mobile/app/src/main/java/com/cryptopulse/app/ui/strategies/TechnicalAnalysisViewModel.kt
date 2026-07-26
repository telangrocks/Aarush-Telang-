package com.cryptopulse.app.ui.strategies

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.api.ActivateBotRequest
import com.cryptopulse.app.data.api.TradingBotService
import com.cryptopulse.app.data.repository.TradeSessionRepository
import com.cryptopulse.app.data.transport.ITransportAdapter
import com.cryptopulse.app.data.transport.PollingTransportAdapter
import com.cryptopulse.app.domain.models.AnalysisSnapshot
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.ui.screens.MarketCandidate
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class TechnicalAnalysisViewModel @Inject constructor(
    private val sessionRepository: TradeSessionRepository,
    private val tradingBotService: TradingBotService
) : ViewModel() {

    private val transportAdapter: ITransportAdapter = PollingTransportAdapter(tradingBotService, pollIntervalMs = 3000L)

    val tradeSetupConfig: StateFlow<TradeSetupConfig?> = sessionRepository.tradeSetupConfig
    val analysisState: StateFlow<AnalysisSnapshot?> = transportAdapter.analysisState
    val isConnected: StateFlow<Boolean> = transportAdapter.isConnected

    private val _isActivating = MutableStateFlow(false)
    val isActivating: StateFlow<Boolean> = _isActivating.asStateFlow()

    private val _activationError = MutableStateFlow<String?>(null)
    val activationError: StateFlow<String?> = _activationError.asStateFlow()

    init {
        transportAdapter.startObserving()
    }

    fun activateBot(
        symbol: String,
        strategy: String,
        config: TradeSetupConfig?,
        onSuccess: () -> Unit
    ) {
        _isActivating.value = true
        _activationError.value = null

        viewModelScope.launch {
            try {
                val response = tradingBotService.activate(
                    ActivateBotRequest(
                        coinId = symbol,
                        strategy = strategy,
                        targetEntryPrice = config?.entryPrice?.takeIf { it > 0.0 },
                        positionSize = config?.tradeValueUsdt?.takeIf { it > 0.0 },
                        config = config?.parameters
                    )
                )

                if (response.isSuccessful && response.body()?.success == true) {
                    _isActivating.value = false
                    transportAdapter.startObserving()
                    onSuccess()
                } else {
                    _isActivating.value = false
                    _activationError.value = response.body()?.message ?: "Failed to activate trading bot."
                }
            } catch (e: Exception) {
                _isActivating.value = false
                _activationError.value = e.message ?: "Network error activating bot."
            }
        }
    }

    fun stopBot(onSuccess: () -> Unit) {
        viewModelScope.launch {
            try {
                tradingBotService.deactivate()
                transportAdapter.stopObserving()
                onSuccess()
            } catch (e: Exception) {
                transportAdapter.stopObserving()
                onSuccess()
            }
        }
    }

    fun checkAndRestoreActiveSession(onSessionRestored: (coinId: String, strategy: String) -> Unit) {
        viewModelScope.launch {
            try {
                val response = tradingBotService.getStatus()
                if (response.isSuccessful && response.body() != null) {
                    val status = response.body()!!
                    if (status.isActive && !status.coinId.isNullOrBlank() && !status.strategy.isNullOrBlank()) {
                        transportAdapter.startObserving()
                        onSessionRestored(status.coinId, status.strategy)
                    }
                }
            } catch (e: Exception) {
                // Silently fail if not active
            }
        }
    }

    private fun String?.isNullMeOrBlank(): Boolean = this == null || this.isBlank()

    override fun onCleared() {
        super.onCleared()
        transportAdapter.stopObserving()
    }
}
