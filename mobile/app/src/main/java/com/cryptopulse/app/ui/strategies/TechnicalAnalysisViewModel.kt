package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.*
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope

import com.cryptopulse.app.data.api.TradingBotService
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.domain.repository.TechnicalAnalysisRepository
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.models.AnalysisSnapshot
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.ui.screens.MarketCandidate
import com.cryptopulse.app.service.TradeAlertManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class TechnicalAnalysisViewModel @Inject constructor(
    private val sessionRepository: TradeSessionRepository,
    private val botRepository: BotRepository,
    private val technicalAnalysisRepository: TechnicalAnalysisRepository,
    private val tradeAlertManager: TradeAlertManager
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

    fun loadPreviewAnalysis(symbol: String, strategy: String, config: TradeSetupConfig? = null) {
        viewModelScope.launch {
            val result = technicalAnalysisRepository.getAnalysisSnapshot(symbol, strategy, config)
            result.onSuccess { snapshot ->
                botRepository.updateAnalysisState(snapshot)
            }
        }
    }

    fun triggerMockAlert(symbol: String, context: android.content.Context) {
        viewModelScope.launch {
            val originalConfig = sessionRepository.tradeSetupConfig.value
            if (originalConfig == null) {
                android.widget.Toast.makeText(context, "No active Trade Setup found.", android.widget.Toast.LENGTH_LONG).show()
                return@launch
            }
            val strategyId = originalConfig.strategyId ?: "ScalperV2"
            
            val mockConfig = originalConfig.copy(
                parameters = originalConfig.parameters + ("forceMockSignal" to "BUY")
            )
            
            val result = technicalAnalysisRepository.getAnalysisSnapshot(symbol, strategyId, mockConfig)
            result.onSuccess { snapshot ->
                snapshot.opportunity?.let { botAlert ->
                    val mockAlertMap = mapOf<String, Any>(
                        "id" to botAlert.id,
                        "symbol" to botAlert.symbol,
                        "entryPrice" to botAlert.entryPrice,
                        "stopLoss" to botAlert.stopLoss,
                        "takeProfit" to botAlert.takeProfit,
                        "estimatedPnl" to botAlert.estimatedPnl,
                        "strategy" to (botAlert.strategy ?: strategyId),
                        "side" to (botAlert.side ?: "BUY"),
                        "timestamp" to (botAlert.timestamp ?: ""),
                        "signalPrice" to (botAlert.signalPrice ?: botAlert.entryPrice),
                        "positionSize" to (botAlert.positionSize ?: 0.0),
                        "isMockTrade" to true
                    ).toMutableMap()
                    
                    botAlert.targetEntryPrice?.let { mockAlertMap["targetEntryPrice"] = it }
                    
                    tradeAlertManager.onNewAlertReceived(mockAlertMap)
                } ?: run {
                    android.widget.Toast.makeText(context, "No valid trade setup currently exists.", android.widget.Toast.LENGTH_LONG).show()
                }
            }.onFailure { e ->
                android.widget.Toast.makeText(context, e.message ?: "Technical analysis unavailable. Please retry.", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    fun activateBot(
        symbol: String,
        strategy: String,
        config: TradeSetupConfig?,
        onSuccess: () -> Unit
    ) {
        _isActivating.value = true
        _activationError.value = null

        val finalConfig = config ?: sessionRepository.tradeSetupConfig.value
        viewModelScope.launch {
            val result = botRepository.activateBot(
                symbol = symbol,
                strategy = strategy,
                config = finalConfig
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
                if (status == com.cryptopulse.app.domain.models.BotState.ANALYSING) {
                    botRepository.startObserving()
                    onSessionRestored("BTCUSDT", "ScalperV2")
                }
            }
        }
    }

    override fun onCleared() {
        super.onCleared()
        botRepository.stopObserving()
    }
}
