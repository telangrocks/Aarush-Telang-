package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.*
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope

import com.cryptopulse.app.data.api.TradingBotService
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.domain.repository.TechnicalAnalysisRepository
import com.cryptopulse.app.domain.repository.StrategyRepository
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.models.AnalysisSnapshot
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.ui.screens.MarketCandidate
import com.cryptopulse.app.service.TradeAlertManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
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
    private val strategyRepository: StrategyRepository,
    private val tradeAlertManager: TradeAlertManager
) : ViewModel() {

    val tradeSetupConfig: StateFlow<TradeSetupConfig?> = sessionRepository.tradeSetupConfig
    val selectedStrategyId: StateFlow<String?> = sessionRepository.selectedStrategyId
    val activeBotState: StateFlow<AnalysisSnapshot?> = botRepository.activeBotAnalysisState
    val isBotActive: StateFlow<Boolean> = botRepository.isBotActive
    val committedStrategyId: StateFlow<String?> = botRepository.committedStrategyId
    val isConnected: StateFlow<Boolean> = botRepository.isConnected

    private val _viewedStrategyId = MutableStateFlow<String>("ScalperV2")
    val viewedStrategyId: StateFlow<String> = _viewedStrategyId.asStateFlow()
    val exploringStrategyId: StateFlow<String> = _viewedStrategyId.asStateFlow()
    val activeStrategyId: StateFlow<String?> = _viewedStrategyId.asStateFlow()

    private val _explorationState = MutableStateFlow<AnalysisSnapshot?>(null)
    val explorationState: StateFlow<AnalysisSnapshot?> = _explorationState.asStateFlow()
    val analysisState: StateFlow<AnalysisSnapshot?> = _explorationState.asStateFlow()

    private val _availableStrategies = MutableStateFlow<List<Strategy>>(emptyList())
    val availableStrategies: StateFlow<List<Strategy>> = _availableStrategies.asStateFlow()

    private val _isActivating = MutableStateFlow(false)
    val isActivating: StateFlow<Boolean> = _isActivating.asStateFlow()

    private val _activationError = MutableStateFlow<String?>(null)
    val activationError: StateFlow<String?> = _activationError.asStateFlow()

    private val _previewError = MutableStateFlow<String?>(null)
    val previewError: StateFlow<String?> = _previewError.asStateFlow()

    private val _isLoadingPreview = MutableStateFlow(false)
    val isLoadingPreview: StateFlow<Boolean> = _isLoadingPreview.asStateFlow()

    private var analysisJob: Job? = null
    private var previewPollingJob: Job? = null
    private var explorationRequestId: Long = 0L

    init {
        val initialStrategy = sessionRepository.selectedStrategyId.value 
            ?: sessionRepository.tradeSetupConfig.value?.strategyId 
            ?: "ScalperV2"
        _viewedStrategyId.value = initialStrategy

        loadAvailableStrategies()
        viewModelScope.launch {
            botRepository.activeBotAnalysisState.collect { botSnapshot ->
                if (botSnapshot != null) {
                    val committedId = botRepository.committedStrategyId.value
                    val viewedId = _viewedStrategyId.value
                    val snapshotStrategyId = botSnapshot.strategyMetadata?.strategyId ?: botSnapshot.engineStatus?.activeStrategy
                    if (isBotActive.value && (committedId != null && committedId.equals(viewedId, ignoreCase = true) || (snapshotStrategyId != null && snapshotStrategyId.equals(viewedId, ignoreCase = true)))) {
                        _explorationState.value = botSnapshot
                        _isLoadingPreview.value = false
                        _previewError.value = null
                    }
                }
            }
        }
    }

    fun onScreenStarted(symbol: String? = null) {
        botRepository.startObserving()
        startPreviewPolling(symbol)
    }

    fun onScreenStopped() {
        stopPreviewPolling()
        if (!isBotActive.value) {
            botRepository.stopObserving()
        }
    }

    fun startPreviewPolling(currentSymbol: String? = null) {
        previewPollingJob?.cancel()
        previewPollingJob = viewModelScope.launch {
            while (isActive) {
                kotlinx.coroutines.delay(5000L)
                if (!isBotActive.value) {
                    val config = sessionRepository.tradeSetupConfig.value
                    val symbolToUse = currentSymbol ?: config?.symbol ?: "BTC/USDT"
                    val strategyToUse = _viewedStrategyId.value
                    loadPreviewAnalysisSilently(symbolToUse, strategyToUse, config)
                }
            }
        }
    }

    fun stopPreviewPolling() {
        previewPollingJob?.cancel()
        previewPollingJob = null
    }

    private fun loadPreviewAnalysisSilently(symbol: String, strategy: String, config: TradeSetupConfig? = null) {
        val requestId = ++explorationRequestId
        val targetStrategy = strategy

        viewModelScope.launch {
            val result = technicalAnalysisRepository.getAnalysisSnapshot(symbol, targetStrategy, config)
            if (requestId != explorationRequestId) return@launch

            result.onSuccess { snapshot ->
                if (requestId == explorationRequestId) {
                    _explorationState.value = snapshot
                    _previewError.value = null
                }
            }.onFailure { error ->
                if (requestId == explorationRequestId && _explorationState.value == null) {
                    _previewError.value = error.message ?: "Technical analysis unavailable."
                }
            }
        }
    }

    fun loadAvailableStrategies() {
        viewModelScope.launch {
            val result = strategyRepository.getStrategies()
            result.onSuccess { strategies ->
                _availableStrategies.value = strategies
            }
        }
    }

    fun selectStrategyForViewing(strategy: String, symbol: String) {
        _viewedStrategyId.value = strategy
        val originalConfig = sessionRepository.tradeSetupConfig.value
        val cleanConfig = originalConfig?.copy(
            strategyId = strategy,
            parameters = if (originalConfig.strategyId == strategy) originalConfig.parameters else emptyMap(),
            riskParameters = originalConfig.riskParameters
        ) ?: TradeSetupConfig(
            strategyId = strategy,
            symbol = symbol,
            entryPrice = 0.0
        )
        loadPreviewAnalysis(symbol, strategy, cleanConfig)
    }

    fun selectStrategy(strategy: String, symbol: String) {
        selectStrategyForViewing(strategy, symbol)
    }

    fun useStrategy(strategy: String) {
        val currentConfig = sessionRepository.tradeSetupConfig.value
        val updatedConfig = currentConfig?.copy(
            strategyId = strategy,
            parameters = if (currentConfig.strategyId == strategy) currentConfig.parameters else emptyMap()
        )
        if (updatedConfig != null) {
            sessionRepository.setTradeSetupConfig(updatedConfig)
        }
        sessionRepository.setStrategyId(strategy)
    }

    fun loadPreviewAnalysis(symbol: String, strategy: String, config: TradeSetupConfig? = null) {
        val requestId = ++explorationRequestId
        if (_explorationState.value == null) {
            _isLoadingPreview.value = true
        }
        _previewError.value = null
        _viewedStrategyId.value = strategy

        analysisJob?.cancel()
        val targetStrategy = strategy

        analysisJob = viewModelScope.launch {
            val result = technicalAnalysisRepository.getAnalysisSnapshot(symbol, targetStrategy, config)
            
            // Stale-response protection: Discard response if newer strategy was requested
            if (requestId != explorationRequestId) {
                return@launch
            }

            result.onSuccess { snapshot ->
                if (requestId == explorationRequestId) {
                    _isLoadingPreview.value = false
                    _explorationState.value = snapshot // Writes exclusively to explorationState
                    _previewError.value = null
                }
            }.onFailure { error ->
                if (requestId == explorationRequestId) {
                    _isLoadingPreview.value = false
                    if (_explorationState.value == null) {
                        _previewError.value = error.message ?: "Technical analysis unavailable. Please verify your exchange connection."
                    }
                }
            }
        }
    }

    fun clearPreviewError() {
        _previewError.value = null
    }

    fun triggerTradeAlert(symbol: String, context: android.content.Context) {
        viewModelScope.launch {
            val originalConfig = sessionRepository.tradeSetupConfig.value
            if (originalConfig == null) {
                android.widget.Toast.makeText(context, "No active Trade Setup found.", android.widget.Toast.LENGTH_LONG).show()
                return@launch
            }
            val targetStrategyId = _viewedStrategyId.value
                ?: sessionRepository.selectedStrategyId.value
                ?: originalConfig.strategyId
                ?: "ScalperV2"

            val executionConfig = originalConfig.copy(
                strategyId = targetStrategyId,
                parameters = if (targetStrategyId == originalConfig.strategyId) originalConfig.parameters else emptyMap()
            )

            val result = botRepository.triggerAlert(symbol, targetStrategyId, executionConfig)
            result.onSuccess { botAlert ->
                val alertMap = mapOf<String, Any>(
                    "id" to botAlert.id,
                    "symbol" to botAlert.symbol,
                    "entryPrice" to botAlert.entryPrice,
                    "stopLoss" to botAlert.stopLoss,
                    "takeProfit" to botAlert.takeProfit,
                    "estimatedPnl" to botAlert.estimatedPnl,
                    "strategy" to (botAlert.strategy ?: targetStrategyId),
                    "side" to (botAlert.side ?: "BUY"),
                    "timestamp" to (botAlert.timestamp ?: ""),
                    "signalPrice" to (botAlert.signalPrice ?: botAlert.entryPrice),
                    "positionSize" to (botAlert.positionSize ?: 0.0),
                    "signalOrigin" to "MANUAL_TRIGGER"
                ).toMutableMap()

                botAlert.targetEntryPrice?.let { alertMap["targetEntryPrice"] = it }
                val intentName = botAlert.entryIntent ?: originalConfig.entryIntent.name
                alertMap["entryIntent"] = intentName

                tradeAlertManager.onNewAlertReceived(alertMap)
            }.onFailure { e ->
                android.widget.Toast.makeText(context, e.message ?: "Failed to generate trade alert. Please retry.", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    fun commitStrategyAndActivateBot(
        symbol: String,
        strategy: String,
        onSuccess: () -> Unit
    ) {
        _isActivating.value = true
        _activationError.value = null

        val baseConfig = sessionRepository.tradeSetupConfig.value
        val committedConfig = baseConfig?.copy(
            strategyId = strategy,
            entryPrice = baseConfig.entryPrice,
            riskParameters = baseConfig.riskParameters,
            entryIntent = baseConfig.entryIntent
        ) ?: TradeSetupConfig(
            strategyId = strategy,
            symbol = symbol,
            entryPrice = 0.0
        )

        viewModelScope.launch {
            val result = botRepository.activateBot(
                symbol = symbol,
                strategy = strategy,
                config = committedConfig
            )
            result.onSuccess {
                _isActivating.value = false
                sessionRepository.setTradeSetupConfig(committedConfig)
                sessionRepository.setStrategyId(strategy)
                botRepository.startObserving()
                onSuccess()
            }.onFailure { e ->
                _isActivating.value = false
                _activationError.value = e.message ?: "Failed to activate trading bot."
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
                if (status.isActive || status.state == com.cryptopulse.app.domain.models.BotState.ANALYSING) {
                    botRepository.startObserving()
                    val restoredCoin = status.coinId ?: "BTCUSDT"
                    val restoredStrategy = status.strategy ?: "ScalperV2"
                    onSessionRestored(restoredCoin, restoredStrategy)
                }
            }
        }
    }

    override fun onCleared() {
        super.onCleared()
        if (!isBotActive.value) {
            botRepository.stopObserving()
        }
    }
}
