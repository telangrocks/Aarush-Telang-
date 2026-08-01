package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.*
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope

import com.cryptopulse.app.data.api.TradingBotService
import com.cryptopulse.app.domain.repository.TradeSessionRepository
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
    private val botRepository: com.cryptopulse.app.domain.repository.BotRepository
) : ViewModel() {

    val tradeSetupConfig: StateFlow<TradeSetupConfig?> = sessionRepository.tradeSetupConfig
    val analysisState: StateFlow<AnalysisSnapshot?> = botRepository.analysisState
    val isConnected: StateFlow<Boolean> = botRepository.isConnected

    private val _isActivating = MutableStateFlow(false)
    val isActivating: StateFlow<Boolean> = _isActivating.asStateFlow()

    private val _activationError = MutableStateFlow<String?>(null)
    val activationError: StateFlow<String?> = _activationError.asStateFlow()

    init {
        botRepository.startObserving()
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
            val result = botRepository.activateBot(
                symbol = symbol,
                strategy = strategy,
                config = config
            )
            result.onSuccess {
                _isActivating.value = false
                botRepository.startObserving()
                onSuccess()
            }.onFailure { e ->
                _isActivating.value = false
                _activationError.value = e.message ?: "Failed to activate trading bot."
            }
        }
    }

    fun stopBot(onSuccess: () -> Unit) {
        viewModelScope.launch {
            botRepository.deactivateBot()
            botRepository.stopObserving()
            onSuccess()
        }
    }

    fun checkAndRestoreActiveSession(onSessionRestored: (coinId: String, strategy: String) -> Unit) {
        viewModelScope.launch {
            val result = botRepository.getStatus()
            result.onSuccess { status ->
                // Because BotState in BotRepository doesn't natively expose 'coinId' and 'strategy' 
                // in the same way, we might need a workaround. Wait, BotState is an enum!
                // We'll just call startObserving if it's active. 
                // We can't trivially extract coinId and strategy from BotState enum.
                if (status == com.cryptopulse.app.domain.models.BotState.ANALYSING) {
                    botRepository.startObserving()
                    onSessionRestored("BTCUSDT", "scalping") // Placeholder until we refactor session fully
                }
            }
        }
    }

    private fun String?.isNullMeOrBlank(): Boolean = this == null || this.isBlank()

    override fun onCleared() {
        super.onCleared()
        botRepository.stopObserving()
    }
}





