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
    val activeStrategyId: StateFlow<String?> = botRepository.committedStrategyId

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
    private var lastEmittedSignalKey: String? = null

    init {
        val initialStrategy = sessionRepository.selectedStrategyId.value 
            ?: sessionRepository.tradeSetupConfig.value?.strategyId 
            ?: "ScalperV2"
        _viewedStrategyId.value = initialStrategy

        loadAvailableStrategies()
        viewModelScope.launch {
            botRepository.activeBotAnalysisState.collect { botSnapshot ->
                if (botSnapshot != null) {
                    val isBotActive = botRepository.isBotActive.value
                    val committedId = botRepository.committedStrategyId.value
                    val viewedId = _viewedStrategyId.value
                    val snapshotStrategyId = botSnapshot.strategyMetadata?.strategyId ?: botSnapshot.engineStatus?.activeStrategy
                    if (isBotActive && committedId != null && committedId.equals(viewedId, ignoreCase = true) && snapshotStrategyId != null && snapshotStrategyId.equals(committedId, ignoreCase = true)) {
                        _explorationState.value = botSnapshot
                        _isLoadingPreview.value = false
                        _previewError.value = null
                    }
                }
            }
        }
    }

    fun sanitizeConfigForStrategy(
        baseConfig: TradeSetupConfig?,
        targetStrategy: String,
        symbol: String
    ): TradeSetupConfig {
        val isSameStrategy = baseConfig?.strategyId?.equals(targetStrategy, ignoreCase = true) == true
        return baseConfig?.copy(
            strategyId = targetStrategy,
            symbol = symbol,
            parameters = if (isSameStrategy) baseConfig.parameters else emptyMap(),
            riskParameters = baseConfig.riskParameters,
            entryPrice = baseConfig.entryPrice,
            tradeValueUsdt = baseConfig.tradeValueUsdt,
            entryIntent = baseConfig.entryIntent
        ) ?: TradeSetupConfig(
            strategyId = targetStrategy,
            symbol = symbol,
            entryPrice = 0.0,
            tradeValueUsdt = null
        )
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
                if (!isBotActive.value || !_viewedStrategyId.value.equals(botRepository.committedStrategyId.value, ignoreCase = true)) {
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
        val cleanConfig = sanitizeConfigForStrategy(originalConfig, strategy, symbol)
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

                    try {
                        val signal = snapshot.tradingSignal
                        val sigKey = "${targetStrategy}_${snapshot.symbol ?: symbol}_${signal?.type}_${snapshot.marketAnalysis?.confidenceScore}_${signal?.targetEntryPrice}"
                        if (sigKey != lastEmittedSignalKey) {
                            lastEmittedSignalKey = sigKey
                            com.cryptopulse.app.forensics.CidDiagnosticManager.logSignalDisplayed(
                                symbol = snapshot.symbol ?: symbol,
                                strategyId = targetStrategy,
                                signalType = signal?.type,
                                marketPrice = signal?.signalPrice,
                                entryPrice = signal?.targetEntryPrice ?: signal?.signalPrice,
                                stopLoss = signal?.stopLoss,
                                takeProfit = signal?.takeProfit,
                                confidence = snapshot.marketAnalysis?.confidenceScore
                            )
                        }
                    } catch (_: Throwable) {}
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

    fun clearActivationError() {
        _activationError.value = null
    }

    fun triggerTradeAlert(symbol: String? = null, context: android.content.Context) {
        viewModelScope.launch {
            val originalConfig = sessionRepository.tradeSetupConfig.value
            val targetStrategyId = _viewedStrategyId.value
                ?: sessionRepository.selectedStrategyId.value
                ?: originalConfig?.strategyId
                ?: "ScalperV2"

            val targetSymbol = (symbol ?: _explorationState.value?.symbol ?: originalConfig?.symbol ?: "").trim()
            if (targetSymbol.isBlank()) {
                android.widget.Toast.makeText(context, "No active qualified trade opportunity available.", android.widget.Toast.LENGTH_LONG).show()
                return@launch
            }

            val executionConfig = originalConfig?.copy(
                strategyId = targetStrategyId,
                symbol = targetSymbol,
                parameters = if (targetStrategyId == originalConfig?.strategyId) (originalConfig?.parameters ?: emptyMap()) else emptyMap()
            ) ?: TradeSetupConfig(
                strategyId = targetStrategyId,
                symbol = targetSymbol,
                entryPrice = 0.0,
                tradeValueUsdt = 5.0
            )

            val result = botRepository.triggerAlert(targetSymbol, targetStrategyId, executionConfig)
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
                val intentName = botAlert.entryIntent ?: originalConfig?.entryIntent?.name ?: executionConfig.entryIntent.name
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
            tradeValueUsdt = baseConfig.tradeValueUsdt,
            riskParameters = baseConfig.riskParameters,
            entryIntent = baseConfig.entryIntent
        ) ?: TradeSetupConfig(
            strategyId = strategy,
            symbol = symbol,
            entryPrice = 0.0,
            tradeValueUsdt = null
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
        symbols: List<String>,
        strategy: String,
        config: TradeSetupConfig?,
        onSuccess: () -> Unit
    ) {
        if (symbols.isEmpty()) {
            _activationError.value = "Cannot activate bot: no eligible candidates available."
            return
        }
        if (_isActivating.value) return
        _isActivating.value = true
        _activationError.value = null

        val primarySymbol = symbols.first()
        val baseConfig = config ?: sessionRepository.tradeSetupConfig.value
        val finalConfig = sanitizeConfigForStrategy(baseConfig, strategy, primarySymbol)
        viewModelScope.launch {
            val result = botRepository.activateBot(
                symbols = symbols,
                strategy = strategy,
                config = finalConfig
            )
            result.onSuccess {
                sessionRepository.setStrategyId(strategy)
                sessionRepository.setTradeSetupConfig(finalConfig)
                _viewedStrategyId.value = strategy
                _isActivating.value = false
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
        if (symbol.isBlank()) {
            _activationError.value = "Cannot activate bot: symbol is blank."
            return
        }
        activateBot(listOf(symbol), strategy, config, onSuccess)
    }

    fun stopBot(onSuccess: () -> Unit) {
        if (_isActivating.value) return
        _isActivating.value = true
        _activationError.value = null

        viewModelScope.launch {
            val result = botRepository.deactivateBot()
            _isActivating.value = false
            botRepository.stopObserving()
            result.onSuccess {
                onSuccess()
            }.onFailure { e ->
                _activationError.value = e.message ?: "Failed to deactivate trading bot."
            }
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
