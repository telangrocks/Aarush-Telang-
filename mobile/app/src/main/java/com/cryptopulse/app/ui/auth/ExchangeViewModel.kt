package com.cryptopulse.app.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.api.ActivateBotRequest
import com.cryptopulse.app.data.api.ConnectExchangeRequest
import com.cryptopulse.app.data.api.ExchangeService
import com.cryptopulse.app.data.api.KlineDto
import com.cryptopulse.app.data.api.KlineService
import com.cryptopulse.app.data.api.MarketCandidateDto
import com.cryptopulse.app.data.api.MarketService
import com.cryptopulse.app.data.api.StrategyDto
import com.cryptopulse.app.data.api.StrategyService
import com.cryptopulse.app.data.api.TechnicalAnalysisRequest
import com.cryptopulse.app.data.api.TechnicalAnalysisResponse
import com.cryptopulse.app.data.api.TechnicalAnalysisService
import com.cryptopulse.app.data.api.TickerResponse
import com.cryptopulse.app.data.api.TickerService
import com.cryptopulse.app.data.api.ValidateExchangeRequest
import com.cryptopulse.app.data.api.ValidationResponse
import com.cryptopulse.app.ui.screens.MarketCandidate
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

data class ExchangeFormState(
    val selectedExchange: String = "binance",
    val environment: String = "testnet",
    val apiKey: String = "",
    val apiSecret: String = "",
    val apiKeyError: String? = null,
    val apiSecretError: String? = null,
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
    private val exchangeService: ExchangeService,
    private val marketService: MarketService,
    private val strategyService: StrategyService,
    private val technicalAnalysisService: TechnicalAnalysisService,
    private val tickerService: TickerService,
    private val klineService: KlineService,
    private val tradingBotService: com.cryptopulse.app.data.api.TradingBotService,
    private val tokenManager: com.cryptopulse.app.data.local.TokenManager,
    private val fcmApi: com.cryptopulse.app.data.api.FcmApi,
    private val exchangeConnectionManager: com.cryptopulse.app.data.local.ExchangeConnectionManager,
) : ViewModel() {

    private val _formState = MutableStateFlow(ExchangeFormState())
    val formState: StateFlow<ExchangeFormState> = _formState

    private val _uiState = MutableStateFlow<ExchangeUiState>(ExchangeUiState.Idle)
    val uiState: StateFlow<ExchangeUiState> = _uiState

    private val _candidates = MutableStateFlow<List<MarketCandidateDto>>(emptyList())
    val candidates: StateFlow<List<MarketCandidateDto>> = _candidates

    private val _readyForCandidates = MutableStateFlow(false)
    val readyForCandidates: StateFlow<Boolean> = _readyForCandidates

    private val _selectedCandidate = MutableStateFlow<MarketCandidate?>(null)
    val selectedCandidate: StateFlow<MarketCandidate?> = _selectedCandidate



    private val _technicalAnalysis = MutableStateFlow<TechnicalAnalysisResponse?>(null)
    val technicalAnalysis: StateFlow<TechnicalAnalysisResponse?> = _technicalAnalysis

    private val _tradeSetup = MutableStateFlow<TradeSetupState?>(null)
    val tradeSetup: StateFlow<TradeSetupState?> = _tradeSetup

    private val _ticker = MutableStateFlow<TickerResponse?>(null)
    val ticker: StateFlow<TickerResponse?> = _ticker

    private val _klines = MutableStateFlow<List<KlineDto>>(emptyList())
    val klines: StateFlow<List<KlineDto>> = _klines

    private val _pendingAlert = MutableStateFlow<Map<String, Any>?>(null)
    val pendingAlert: StateFlow<Map<String, Any>?> = _pendingAlert

    private val _lastTrade = MutableStateFlow<TradeSetupState?>(null)
    val lastTrade: StateFlow<TradeSetupState?> = _lastTrade

    private val _positions = MutableStateFlow<List<com.cryptopulse.app.data.api.PositionResponse>>(emptyList())
    val positions: StateFlow<List<com.cryptopulse.app.data.api.PositionResponse>> = _positions

    // ── User-facing error state for previously silent-failure paths ──────────
    private val _candidatesError = MutableStateFlow<String?>(null)
    val candidatesError: StateFlow<String?> = _candidatesError

    private val _analysisError = MutableStateFlow<String?>(null)
    val analysisError: StateFlow<String?> = _analysisError

    private val _tradeError = MutableStateFlow<String?>(null)
    val tradeError: StateFlow<String?> = _tradeError

    private val _botError = MutableStateFlow<String?>(null)
    val botError: StateFlow<String?> = _botError

    fun clearCandidatesError() { _candidatesError.value = null }
    fun clearAnalysisError() { _analysisError.value = null }
    fun clearTradeError() { _tradeError.value = null }
    fun clearBotError() { _botError.value = null }

    fun fetchPositions() {
        viewModelScope.launch {
            try {
                val token = tokenManager.getToken()
                if (token != null) {
                    val response = tradingBotService.getPositions()
                    if (response.isSuccessful && response.body() != null) {
                        _positions.value = response.body()!!
                    }
                }
            } catch (e: Exception) {
                // Silently fail
            }
        }
    }

    fun closePosition(positionId: String) {
        viewModelScope.launch {
            try {
                val token = tokenManager.getToken()
                if (token != null) {
                    tradingBotService.closePosition(positionId)
                }
            } catch (e: Exception) {
                // Silently fail
            }
        }
    }

    fun onExchangeSelected(exchange: String) {
        _formState.value = _formState.value.copy(selectedExchange = exchange)
    }

    fun onEnvironmentSelected(environment: String) {
        _formState.value = _formState.value.copy(environment = environment)
    }

    fun onApiKeyChanged(apiKey: String) {
        _formState.value = _formState.value.copy(apiKey = apiKey, apiKeyError = null)
    }

    fun onApiSecretChanged(apiSecret: String) {
        _formState.value = _formState.value.copy(apiSecret = apiSecret, apiSecretError = null)
    }

    private fun getUserFriendlyErrorMessage(
        response: retrofit2.Response<*>? = null,
        exception: Exception? = null
    ): Pair<String, String?> {
        if (response != null) {
            println("Exchange API error: ${response.code()} ${response.message()}")
            val errorBody = response.errorBody()
            errorBody?.string()?.let { println("Error body: $it") }
        } else if (exception != null) {
            println("Exchange API exception: ${exception::class.simpleName}: ${exception.message}")
            exception.printStackTrace()
        }

        if (response != null && response.isSuccessful && response.body() != null) {
            val body = response.body()!!
            when (body) {
                is ValidationResponse -> {
                    if (!body.success) {
                        return body.message to body.hint
                    }
                }
                is com.cryptopulse.app.data.api.ConnectExchangeResponse -> {
                    if (!body.success) {
                        return body.message to body.hint
                    }
                }
            }
        }

        if (response != null && !response.isSuccessful) {
            return when (response.code()) {
                400 -> "Invalid request. Please check your API key and secret." to null
                401 -> "Authentication failed. Invalid API key or secret." to null
                403 -> "Access forbidden. Check your IP whitelist or permissions." to null
                404 -> "Exchange endpoint not found. Please check your exchange selection." to null
                429 -> "Rate limit exceeded. Please try again later." to null
                500, 502, 503, 504 -> "Exchange service unavailable. Please try again later." to null
                else -> "Request failed. Please try again." to null
            }
        }

        if (exception != null) {
            return when (exception) {
                is SocketTimeoutException -> "Connection timeout. Please check your internet connection." to null
                is UnknownHostException -> "No internet connection. Please check your network." to null
                is IOException -> "Network error. Please check your internet connection." to null
                else -> "An unexpected error occurred. Please try again." to null
            }
        }

        return "An unknown error occurred. Please try again." to null
    }

    fun validateAndConnect() {
        val state = _formState.value
        var apiKeyError: String? = null
        var apiSecretError: String? = null

        if (state.apiKey.isBlank()) {
            apiKeyError = "API Key is required"
        }
        if (state.apiSecret.isBlank()) {
            apiSecretError = "API Secret is required"
        }

        if (apiKeyError != null || apiSecretError != null) {
            _formState.value = state.copy(
                apiKeyError = apiKeyError,
                apiSecretError = apiSecretError,
            )
            return
        }

        viewModelScope.launch {
            _uiState.value = ExchangeUiState.Validating
            _formState.value = _formState.value.copy(isLoading = true, validationMessage = null)

            try {
                val validationRequest = ValidateExchangeRequest(
                    exchangeName = state.selectedExchange,
                    apiKey = state.apiKey,
                    apiSecret = state.apiSecret,
                    environment = state.environment,
                )
                val validationResponse = exchangeService.validate(validationRequest)

                if (!validationResponse.isSuccessful || validationResponse.body()?.success != true) {
                    val (userMessage, hint) = getUserFriendlyErrorMessage(response = validationResponse)
                    _uiState.value = ExchangeUiState.Error(userMessage, hint)
                    _formState.value = _formState.value.copy(isLoading = false, validationMessage = userMessage)
                    return@launch
                }

                _formState.value = _formState.value.copy(validationMessage = "Credentials valid. Connecting...")

                val connectRequest = ConnectExchangeRequest(
                    exchangeName = state.selectedExchange,
                    apiKey = state.apiKey,
                    apiSecret = state.apiSecret,
                    environment = state.environment,
                )
                val connectResponse = exchangeService.connect(connectRequest)

                if (!connectResponse.isSuccessful || connectResponse.body()?.success != true) {
                    val (userMessage, hint) = getUserFriendlyErrorMessage(response = connectResponse)
                    _uiState.value = ExchangeUiState.Error(userMessage, hint)
                    _formState.value = _formState.value.copy(isLoading = false, validationMessage = userMessage)
                    return@launch
                }

                _formState.value = _formState.value.copy(isLoading = false)
                _uiState.value = ExchangeUiState.Connected(state.selectedExchange)

                exchangeConnectionManager.saveConnection(state.selectedExchange, state.environment)

                fetchMarketCandidates()
            } catch (e: Exception) {
                val (userMessage, hint) = getUserFriendlyErrorMessage(exception = e)
                _uiState.value = ExchangeUiState.Error(userMessage, hint)
                _formState.value = _formState.value.copy(isLoading = false, validationMessage = userMessage)
            }
        }
    }

    fun fetchMarketCandidates() {
        _candidatesError.value = null
        viewModelScope.launch {
            try {
                val response = marketService.getCandidates()
                if (response.isSuccessful && response.body() != null) {
                    _candidates.value = response.body()!!
                    _readyForCandidates.value = true
                } else {
                    _candidatesError.value = getUserFriendlyErrorMessage(response = response).first
                }
            } catch (e: Exception) {
                _candidatesError.value = getUserFriendlyErrorMessage(exception = e).first
            }
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
        _lastTrade.value = null
        _positions.value = emptyList()
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

    /**
     * Restores an existing Focus Mode session from the backend without triggering
     * a new market scan or bot activation. Called when the app is reopened while
     * the backend Durable Object already has an active locked instrument.
     *
     * Builds a minimal [MarketCandidate] from the [coinId] so the live_analysis
     * screen has a valid selection to display. Price and metadata are intentionally
     * left at zero — the live_analysis screen fetches its own live data from the
     * backend analysis-status endpoint.
     */
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
            coinColor = androidx.compose.ui.graphics.Color(0xFF00B4FF),
        )
        // strategy ignored in ExchangeViewModel as it's now handled by StrategySelectionViewModel
    }




    fun fetchTechnicalAnalysis(strategy: String, config: Map<String, Any>? = null) {
        val candidate = _selectedCandidate.value ?: return
        _analysisError.value = null

        viewModelScope.launch {
            try {
                val response = technicalAnalysisService.getAnalysis(
                    TechnicalAnalysisRequest(
                        symbol = candidate.symbol,
                        strategy = strategy,
                        config = config
                    )
                )
                if (response.isSuccessful && response.body() != null) {
                    _technicalAnalysis.value = response.body()
                } else {
                    _analysisError.value = getUserFriendlyErrorMessage(response = response).first
                }
            } catch (e: Exception) {
                _analysisError.value = getUserFriendlyErrorMessage(exception = e).first
            }
        }
    }

    fun fetchTicker() {
        val candidate = _selectedCandidate.value ?: return

        viewModelScope.launch {
            try {
                val response = tickerService.getTicker(candidate.symbol)
                if (response.isSuccessful && response.body() != null) {
                    _ticker.value = response.body()
                }
            } catch (e: Exception) {
                // Silently fail
            }
        }
    }

    fun fetchKlines(interval: String = "1h", limit: Int = 100) {
        val candidate = _selectedCandidate.value ?: return

        viewModelScope.launch {
            try {
                val response = klineService.getKlines(candidate.symbol, interval, limit)
                if (response.isSuccessful && response.body() != null) {
                    _klines.value = response.body()!!
                }
            } catch (e: Exception) {
                // Silently fail
            }
        }
    }

    fun setPendingAlert(alert: Map<String, Any>) {
        _pendingAlert.value = alert
    }

    fun setPendingBotAlert(alert: com.cryptopulse.app.data.api.BotAlert) {
        _pendingAlert.value = mapOf(
            "id" to alert.id,
            "symbol" to alert.symbol,
            "entryPrice" to alert.entryPrice,
            "stopLoss" to alert.stopLoss,
            "takeProfit" to alert.takeProfit,
            "estimatedPnl" to alert.estimatedPnl,
            "strategy" to (alert.strategy ?: ""),
            "side" to (alert.side ?: "BUY"),
        )
    }

    fun dismissCurrentAlert() {
        val alertId = _pendingAlert.value?.get("id") as? String
        if (alertId != null) {
            viewModelScope.launch {
                try {
                    val token = tokenManager.getToken()
                    if (token != null) {
                        tradingBotService.acknowledgeAlert(mapOf("alertId" to alertId))
                    }
                } catch (e: Exception) {
                    // Silently fail
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
        // Clear any previous result so observers can unambiguously detect the
        // outcome of THIS execution (fresh _lastTrade == success signal).
        _lastTrade.value = null

        viewModelScope.launch {
            try {
                val token = tokenManager.getToken()
                if (token != null) {
                    val response = tradingBotService.executeTrade()
                    if (response.isSuccessful && response.body() != null) {
                        val body = response.body()!!
                        val success = body["success"] as? Boolean ?: false
                        
                        if (success) {
                            val alertId = alert["id"] as? String
                            if (alertId != null) {
                                tradingBotService.acknowledgeAlert(mapOf("alertId" to alertId))
                            }
                            _pendingAlert.value = null
                            val entryPrice = (alert["entryPrice"] as? Double)
                                ?: tradeSetup?.entryPrice ?: 0.0
                            val stopLoss = (alert["stopLoss"] as? Double)
                                ?: tradeSetup?.stopLossPrice ?: entryPrice * 0.99
                            val takeProfit = (alert["takeProfit"] as? Double)
                                ?: tradeSetup?.takeProfitPrice ?: entryPrice * 1.02
                            _lastTrade.value = TradeSetupState(
                                entryPrice = entryPrice,
                                stopLossPrice = stopLoss,
                                takeProfitPrice = takeProfit,
                            )
                        } else {
                            val order = body["order"] as? Map<String, Any>
                            val friendlyMsg = order?.get("friendlyMessage") as? String
                            val message = body["message"] as? String
                            _tradeError.value = friendlyMsg ?: message ?: "Trade execution failed."
                        }
                    } else {
                        _tradeError.value = getUserFriendlyErrorMessage(response = response).first
                    }
                } else {
                    _tradeError.value = "Your session has expired. Please sign in again."
                }
            } catch (e: Exception) {
                _tradeError.value = getUserFriendlyErrorMessage(exception = e).first
            }
        }
    }

    fun activateBot(symbol: String, strategy: String, config: Map<String, Any>? = null) {
        _botError.value = null
        val targetPrice = _tradeSetup.value?.entryPrice
        viewModelScope.launch {
            try {
                val token = tokenManager.getToken()
                if (token != null) {
                    val response = tradingBotService.activate(
                        ActivateBotRequest(
                            coinId = symbol,
                            strategy = strategy,
                            targetEntryPrice = targetPrice,
                            config = config
                        )
                    )
                    if (!response.isSuccessful) {
                        _botError.value = getUserFriendlyErrorMessage(response = response).first
                    }
                }
            } catch (e: Exception) {
                _botError.value = getUserFriendlyErrorMessage(exception = e).first
            }
        }
    }

    fun registerFcmToken(fcmToken: String) {
        viewModelScope.launch {
            try {
                val token = tokenManager.getToken()
                if (token != null) {
                    val request = mapOf("fcmToken" to fcmToken)
                    fcmApi.registerToken(request)
                }
            } catch (e: Exception) {
                // Silently fail
            }
        }
    }
}