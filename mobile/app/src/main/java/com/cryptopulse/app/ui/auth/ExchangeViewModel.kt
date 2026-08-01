package com.cryptopulse.app.ui.auth

import com.cryptopulse.app.core.network.*
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope

import android.util.Log
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.repository.ExchangeRepository
import com.cryptopulse.app.domain.repository.FcmRepository
import com.cryptopulse.app.domain.repository.MarketRepository
import com.cryptopulse.app.domain.repository.TechnicalAnalysisRepository
import com.cryptopulse.app.domain.models.BotAlert
import com.cryptopulse.app.domain.models.DomainException
import com.cryptopulse.app.domain.models.Kline
import com.cryptopulse.app.ui.screens.MarketCandidate
import com.cryptopulse.app.domain.models.TechnicalAnalysisResult
import com.cryptopulse.app.domain.models.Ticker
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.inject.Inject

sealed class ExchangeUiState {
    object Idle : ExchangeUiState()
    object Validating : ExchangeUiState()
    object Connecting : ExchangeUiState()
    data class Connected(val exchangeName: String) : ExchangeUiState()
    data class Error(val message: String, val hint: String? = null) : ExchangeUiState()
}

sealed interface MarketDataUiState {
    object Idle : MarketDataUiState
    object Loading : MarketDataUiState
    data class Success(val candidates: List<MarketCandidate>) : MarketDataUiState
    data class Empty(val message: String) : MarketDataUiState
    data class Error(val message: String, val hint: String? = null) : MarketDataUiState
}

data class ExchangeFormState(
    val selectedExchange: String = "binance",
    val environment: String = "testnet",
    val apiKey: String = "",
    val apiSecret: String = "",
    val apiPassphrase: String = "",
    val apiKeyError: String? = null,
    val apiSecretError: String? = null,
    val apiPassphraseError: String? = null,
    val isLoading: Boolean = false,
    val validationMessage: String? = null,
)

data class TradeSetupState(
    val entryPrice: Double = 0.0,
    val stopLossPrice: Double = 0.0,
    val takeProfitPrice: Double = 0.0,
)

@HiltViewModel
class ExchangeViewModel @Inject constructor(
    @dagger.hilt.android.qualifiers.ApplicationContext private val appContext: android.content.Context,
    private val exchangeRepository: ExchangeRepository,
    private val marketRepository: MarketRepository,
    private val technicalAnalysisRepository: TechnicalAnalysisRepository,
    private val botRepository: BotRepository,
    private val fcmRepository: FcmRepository,
    private val tokenManager: com.cryptopulse.app.data.local.TokenManager,
    private val exchangeConnectionManager: com.cryptopulse.app.data.local.ExchangeConnectionManager,
    private val sessionRepository: com.cryptopulse.app.domain.repository.TradeSessionRepository
) : ViewModel() {

    private val _formState = MutableStateFlow(ExchangeFormState())
    val formState: StateFlow<ExchangeFormState> = _formState

    private val _uiState = MutableStateFlow<ExchangeUiState>(ExchangeUiState.Idle)
    val uiState: StateFlow<ExchangeUiState> = _uiState

    private val _candidates = MutableStateFlow<List<MarketCandidate>>(emptyList())
    val candidates: StateFlow<List<MarketCandidate>> = _candidates

    private val _candidatesLoading = MutableStateFlow(false)
    val candidatesLoading: StateFlow<Boolean> = _candidatesLoading

    private val _marketDataState = MutableStateFlow<MarketDataUiState>(MarketDataUiState.Idle)
    val marketDataState: StateFlow<MarketDataUiState> = _marketDataState

    private val _readyForCandidates = MutableStateFlow(false)
    val readyForCandidates: StateFlow<Boolean> = _readyForCandidates

    private val _selectedCandidate = MutableStateFlow<MarketCandidate?>(null)
    val selectedCandidate: StateFlow<MarketCandidate?> = _selectedCandidate

    init {
        Log.d("VM_CHECK", "[DIAGNOSTIC] ExchangeViewModel hash=${System.identityHashCode(this)}")
        Log.d("ExchangeViewModel", "[DIAGNOSTIC] ViewModel created: ${System.identityHashCode(this)}")
    }

    private val _technicalAnalysis = MutableStateFlow<TechnicalAnalysisResult?>(null)
    val technicalAnalysis: StateFlow<TechnicalAnalysisResult?> = _technicalAnalysis

    private val _tradeSetup = MutableStateFlow<TradeSetupState?>(null)
    val tradeSetup: StateFlow<TradeSetupState?> = _tradeSetup

    private val _ticker = MutableStateFlow<Ticker?>(null)
    val ticker: StateFlow<Ticker?> = _ticker

    private val _klines = MutableStateFlow<List<Kline>>(emptyList())
    val klines: StateFlow<List<Kline>> = _klines

    private val _pendingAlert = MutableStateFlow<Map<String, Any>?>(null)
    val pendingAlert: StateFlow<Map<String, Any>?> = _pendingAlert

    private val _lastTrade = MutableStateFlow<TradeSetupState?>(null)
    val lastTrade: StateFlow<TradeSetupState?> = _lastTrade


    // ── User-facing error state ──────────
    private val _candidatesError = MutableStateFlow<String?>(null)
    val candidatesError: StateFlow<String?> = _candidatesError

    private val _analysisError = MutableStateFlow<String?>(null)
    val analysisError: StateFlow<String?> = _analysisError

    private val _tradeError = MutableStateFlow<String?>(null)
    val tradeError: StateFlow<String?> = _tradeError

    private val _botError = MutableStateFlow<String?>(null)
    val botError: StateFlow<String?> = _botError

    private val _balances = MutableStateFlow<List<com.cryptopulse.app.domain.models.BalanceItem>>(emptyList())
    val balances: StateFlow<List<com.cryptopulse.app.domain.models.BalanceItem>> = _balances

    private val _balancesError = MutableStateFlow<String?>(null)
    val balancesError: StateFlow<String?> = _balancesError

    fun clearCandidatesError() { _candidatesError.value = null }
    fun clearAnalysisError() { _analysisError.value = null }
    fun clearTradeError() { _tradeError.value = null }
    fun clearBotError() { _botError.value = null }
    fun clearBalancesError() { _balancesError.value = null }

    fun onExchangeSelected(exchange: String) {
        _formState.value = _formState.value.copy(selectedExchange = exchange)
    }

    fun onEnvironmentSelected(environment: String) {
        _formState.value = _formState.value.copy(environment = environment)
    }

    fun onApiKeyChanged(apiKey: String) {
        val sanitized = apiKey.trim()
        _formState.value = _formState.value.copy(apiKey = sanitized, apiKeyError = null)
        if (_uiState.value is ExchangeUiState.Error) {
            _uiState.value = ExchangeUiState.Idle
        }
    }

    fun onApiSecretChanged(apiSecret: String) {
        val sanitized = apiSecret.trim()
        _formState.value = _formState.value.copy(apiSecret = sanitized, apiSecretError = null)
        if (_uiState.value is ExchangeUiState.Error) {
            _uiState.value = ExchangeUiState.Idle
        }
    }

    fun onApiPassphraseChanged(passphrase: String) {
        val sanitized = passphrase.trim()
        _formState.value = _formState.value.copy(apiPassphrase = sanitized, apiPassphraseError = null)
        if (_uiState.value is ExchangeUiState.Error) {
            _uiState.value = ExchangeUiState.Idle
        }
    }

    private fun getUserFriendlyErrorMessage(
        endpointName: String = "API",
        exception: Throwable
    ): Pair<String, String?> {
        Log.e(TAG, "[DIAGNOSTIC] Error | Endpoint: $endpointName | Exception Class: ${exception::class.java.name} | Message: ${exception.message}", exception)

        if (exception is DomainException) {
            return exception.message to exception.code
        }

        val exMsgPair = when (exception) {
            is SocketTimeoutException -> "Connection timeout. Please check your internet connection." to null
            is UnknownHostException -> "No internet connection. Please check your network." to null
            is IOException -> "Network error. Please check your internet connection." to null
            else -> "An unexpected error occurred. Please try again." to null
        }
        return exMsgPair
    }

    fun validateAndConnect() {
        val state = _formState.value
        var apiKeyError: String? = null
        var apiSecretError: String? = null
        var apiPassphraseError: String? = null

        if (state.apiKey.isBlank()) {
            apiKeyError = "API Key is required"
        }
        if (state.apiSecret.isBlank()) {
            apiSecretError = "API Secret is required"
        }
        if (state.selectedExchange.equals("kucoin", ignoreCase = true) && state.apiPassphrase.isBlank()) {
            apiPassphraseError = "API Passphrase is required for KuCoin"
        }

        if (apiKeyError != null || apiSecretError != null || apiPassphraseError != null) {
            _formState.value = state.copy(
                apiKeyError = apiKeyError,
                apiSecretError = apiSecretError,
                apiPassphraseError = apiPassphraseError,
            )
            return
        }

        viewModelScope.launch {
            _uiState.value = ExchangeUiState.Validating
            _formState.value = _formState.value.copy(isLoading = true, validationMessage = null)

            val valResult = exchangeRepository.validateKeys(
                exchangeName = state.selectedExchange,
                apiKey = state.apiKey,
                apiSecret = state.apiSecret,
                apiPassphrase = state.apiPassphrase.takeIf { it.isNotBlank() },
                environment = state.environment,
                )

            if (valResult is NetworkResult.Error) { val e = valResult.exceptionOrNull() ?: Exception();
                val (userMessage, hint) = getUserFriendlyErrorMessage(endpointName = "/api/exchange/validate", exception = e)
                _uiState.value = ExchangeUiState.Error(userMessage, hint)
                _formState.value = _formState.value.copy(isLoading = false, validationMessage = userMessage)
                return@launch
            }

            _formState.value = _formState.value.copy(validationMessage = "Credentials valid. Connecting...")

            val connResult = exchangeRepository.connectExchange(
                exchangeName = state.selectedExchange,
                apiKey = state.apiKey,
                apiSecret = state.apiSecret,
                apiPassphrase = state.apiPassphrase.takeIf { it.isNotBlank() },
                environment = state.environment,
                )

            if (connResult is NetworkResult.Error) { val e = connResult.exceptionOrNull() ?: Exception();
                val (userMessage, hint) = getUserFriendlyErrorMessage(endpointName = "/api/exchange/connect", exception = e)
                _uiState.value = ExchangeUiState.Error(userMessage, hint)
                _formState.value = _formState.value.copy(isLoading = false, validationMessage = userMessage)
                return@launch
            }

            _formState.value = _formState.value.copy(isLoading = false)
            _uiState.value = ExchangeUiState.Connected(state.selectedExchange)

            exchangeConnectionManager.saveConnection(state.selectedExchange, state.environment)

            fetchMarketCandidates()
        }
    }

    fun fetchMarketCandidates() {
        _candidatesError.value = null
        _candidatesLoading.value = true
        _marketDataState.value = MarketDataUiState.Loading
        viewModelScope.launch {
            val result = marketRepository.getCandidates()
            result.onSuccess { list ->
                val uiList = list.map { dto ->
                    MarketCandidate(
                        rank = dto.rank,
                        symbol = dto.symbol,
                        pairName = "${dto.symbol}/USDT",
                        coinName = dto.symbol,
                        notations = 0,
                        currentMarketPrice = dto.currentMarketPrice,
                        minNotional = dto.minNotional,
                        coinColor = androidx.compose.ui.graphics.Color.Gray
                    )
                }
                _candidates.value = uiList
                _readyForCandidates.value = true
                if (uiList.isEmpty()) {
                    val emptyMsg = "No market candidates matching volume criteria found on exchange."
                    _candidatesError.value = emptyMsg
                    _marketDataState.value = MarketDataUiState.Empty(emptyMsg)
                } else {
                    _marketDataState.value = MarketDataUiState.Success(uiList)
                }
            }.onFailure { e ->
                val (errMsg, hintMsg) = getUserFriendlyErrorMessage(endpointName = "/api/market/candidates", exception = e)
                _candidatesError.value = errMsg
                _marketDataState.value = MarketDataUiState.Error(errMsg, hintMsg)
            }
            _candidatesLoading.value = false
        }
    }

    fun resetState() {
        _uiState.value = ExchangeUiState.Idle
        _formState.value = ExchangeFormState()
        _candidates.value = emptyList()
        _readyForCandidates.value = false
        _selectedCandidate.value = null

        _technicalAnalysis.value = null
        _tradeSetup.value = null
        _ticker.value = null
        _klines.value = emptyList()
        _pendingAlert.value = null

        _candidatesError.value = null
        _analysisError.value = null
        _tradeError.value = null
        _botError.value = null
        viewModelScope.launch {
            exchangeConnectionManager.clearConnection()
        }
    }

    fun setTradeSetup(entryPrice: Double, stopLoss: Double, takeProfit: Double) {
        _tradeSetup.value = TradeSetupState(entryPrice, stopLoss, takeProfit)
    }

    fun selectCandidate(candidate: MarketCandidate) {
        _selectedCandidate.value = candidate
    }

    fun restoreSession(coinId: String, strategy: String?) {
        val symbol = coinId.replace("/USDT", "").replace("USDT", "").uppercase()
        _selectedCandidate.value = MarketCandidate(
            rank = 0,
            symbol = symbol,
            pairName = "$symbol/USDT",
            coinName = symbol,
            notations = 0,
            currentMarketPrice = 0.0,
            minNotional = 0.0,
            coinColor = androidx.compose.ui.graphics.Color(0xFF00B4FF)
        )
    }

    fun fetchTechnicalAnalysis(strategy: String, config: Map<String, Any>? = null) {
        val candidate = _selectedCandidate.value ?: return
        _analysisError.value = null
        val tradeConfig = sessionRepository.tradeSetupConfig.value

        viewModelScope.launch {
            val result = technicalAnalysisRepository.getAnalysis(candidate.symbol, strategy, tradeConfig)
            result.onSuccess {
                _technicalAnalysis.value = it
            }.onFailure { e ->
                _analysisError.value = getUserFriendlyErrorMessage(endpointName = "/api/market/technical-analysis", exception = e).first
            }
        }
    }

    fun fetchTicker() {
        val candidate = _selectedCandidate.value ?: return
        viewModelScope.launch {
            marketRepository.getTicker(candidate.symbol).onSuccess { _ticker.value = it }
        }
    }

    fun fetchKlines(interval: String = "1h", limit: Int = 100) {
        val symbol = _selectedCandidate.value?.symbol ?: return
        viewModelScope.launch {
            marketRepository.getKlines(symbol, interval, limit).onSuccess { _klines.value = it }
        }
    }

    fun fetchBalances() {
        viewModelScope.launch {
            exchangeRepository.getBalances().onSuccess { body ->
                _balances.value = body
                _balancesError.value = null
            }.onFailure { e ->
                _balancesError.value = e.message ?: "Network error"
            }
        }
    }

    fun setPendingAlert(alert: Map<String, Any>) {
        _pendingAlert.value = alert
    }

    fun setPendingBotAlert(alert: BotAlert) {
        _pendingAlert.value = mapOf(
            "id" to alert.id,
            "symbol" to alert.symbol,
            "entryPrice" to alert.entryPrice,
            "stopLoss" to (alert.stopLoss ?: 0.0),
            "takeProfit" to (alert.takeProfit ?: 0.0),
            "estimatedPnl" to (alert.estimatedPnl ?: 0.0),
            "strategy" to (alert.strategy ?: ""),
            "side" to (alert.side ?: "BUY"),
        )
    }

    fun dismissCurrentAlert() {
        com.cryptopulse.app.service.TradeAlertManager.getInstance(appContext).dismissOrExecuteAlert()
        val alertId = _pendingAlert.value?.get("id") as? String
        if (alertId != null) {
            viewModelScope.launch {
                val token = tokenManager.getToken()
                if (token != null) {
                    botRepository.acknowledgeAlert(alertId)
                }
            }
        }
        _pendingAlert.value = null
    }

    fun executeCurrentTrade() {
        val alert = _pendingAlert.value
        if (alert == null) {
            _tradeError.value = "No active trade opportunity to execute. Please try again."
            return
        }
        val tradeSetup = _tradeSetup.value
        _tradeError.value = null
        _lastTrade.value = null

        viewModelScope.launch {
            val token = tokenManager.getToken()
            if (token != null) {
                val result = botRepository.executeTrade()
                result.onSuccess {
                    val alertId = alert["id"] as? String ?: ""
                    botRepository.acknowledgeAlert(alertId)
                    _pendingAlert.value = null
                    
                    val entryPrice = (alert["entryPrice"] as? Double) ?: tradeSetup?.entryPrice ?: 0.0
                    val stopLoss = (alert["stopLoss"] as? Double) ?: tradeSetup?.stopLossPrice ?: entryPrice * 0.99
                    val takeProfit = (alert["takeProfit"] as? Double) ?: tradeSetup?.takeProfitPrice ?: entryPrice * 1.02
                    
                    _lastTrade.value = TradeSetupState(
                        entryPrice = entryPrice,
                        stopLossPrice = stopLoss,
                        takeProfitPrice = takeProfit,
                    )
                }.onFailure { e ->
                    _tradeError.value = getUserFriendlyErrorMessage(endpointName = "/api/trading-bot/execute-trade", exception = e).first
                }
            } else {
                _tradeError.value = "Your session has expired. Please sign in again."
            }
        }
    }

    fun activateBot(symbol: String, strategy: String, config: Map<String, Any>? = null) {
        _botError.value = null
        val tradeConfig = sessionRepository.tradeSetupConfig.value
        viewModelScope.launch {
            val token = tokenManager.getToken()
            if (token != null) {
                val result = botRepository.activateBot(symbol, strategy, tradeConfig)
                result.onFailure { e ->
                    _botError.value = getUserFriendlyErrorMessage(endpointName = "/api/trading-bot/activate", exception = e).first
                }
            }
        }
    }

    fun registerFcmToken(fcmToken: String) {
        viewModelScope.launch {
            val token = tokenManager.getToken()
            if (token != null) {
                fcmRepository.registerToken(fcmToken)
            }
        }
    }

    companion object {
        private const val TAG = "ExchangeViewModel"
    }
}






