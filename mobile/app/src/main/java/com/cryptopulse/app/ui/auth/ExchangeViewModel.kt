package com.cryptopulse.app.ui.auth

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.api.ActivateBotRequest
import com.cryptopulse.app.data.api.ConnectExchangeRequest
import com.cryptopulse.app.data.api.ExchangeService
import com.cryptopulse.app.data.api.KlineDto
import com.cryptopulse.app.data.api.KlineService
import com.cryptopulse.app.data.api.MarketCandidateDto
import com.cryptopulse.app.data.api.MarketService
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

sealed interface MarketDataUiState {
    object Idle : MarketDataUiState
    object Loading : MarketDataUiState
    data class Success(val candidates: List<MarketCandidateDto>) : MarketDataUiState
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
    private val exchangeService: ExchangeService,
    private val marketService: MarketService,
    private val technicalAnalysisService: TechnicalAnalysisService,
    private val tickerService: TickerService,
    private val klineService: KlineService,
    private val tradingBotService: com.cryptopulse.app.data.api.TradingBotService,
    private val tokenManager: com.cryptopulse.app.data.local.TokenManager,
    private val fcmApi: com.cryptopulse.app.data.api.FcmApi,
    private val exchangeConnectionManager: com.cryptopulse.app.data.local.ExchangeConnectionManager,
    private val sessionRepository: com.cryptopulse.app.data.repository.TradeSessionRepository
) : ViewModel() {

    private val _formState = MutableStateFlow(ExchangeFormState())
    val formState: StateFlow<ExchangeFormState> = _formState

    private val _uiState = MutableStateFlow<ExchangeUiState>(ExchangeUiState.Idle)
    val uiState: StateFlow<ExchangeUiState> = _uiState

    private val _candidates = MutableStateFlow<List<MarketCandidateDto>>(emptyList())
    val candidates: StateFlow<List<MarketCandidateDto>> = _candidates

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
        viewModelScope.launch {
            uiState.collect { Log.d("ExchangeViewModel", "[DIAGNOSTIC] uiState changed: $it") }
        }
        viewModelScope.launch {
            readyForCandidates.collect { Log.d("ExchangeViewModel", "[DIAGNOSTIC] readyForCandidates changed: $it") }
        }
        viewModelScope.launch {
            candidates.collect { Log.d("ExchangeViewModel", "[DIAGNOSTIC] candidates changed, count: ${it.size}") }
        }
    }

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


    // ── User-facing error state for previously silent-failure paths ──────────
    private val _candidatesError = MutableStateFlow<String?>(null)
    val candidatesError: StateFlow<String?> = _candidatesError

    private val _analysisError = MutableStateFlow<String?>(null)
    val analysisError: StateFlow<String?> = _analysisError

    private val _tradeError = MutableStateFlow<String?>(null)
    val tradeError: StateFlow<String?> = _tradeError

    private val _botError = MutableStateFlow<String?>(null)
    val botError: StateFlow<String?> = _botError

    private val _balances = MutableStateFlow<List<com.cryptopulse.app.data.api.BalanceItemData>>(emptyList())
    val balances: StateFlow<List<com.cryptopulse.app.data.api.BalanceItemData>> = _balances

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

    private suspend fun getUserFriendlyErrorMessage(
        endpointName: String = "Exchange API",
        response: retrofit2.Response<*>? = null,
        exception: Exception? = null
    ): Pair<String, String?> = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        var rawErrorBody: String? = null
        var parsedMessage: String? = null
        var parsedHint: String? = null

        if (response != null) {
            try {
                if (!response.isSuccessful) {
                    rawErrorBody = response.errorBody()?.string()
                    Log.e(TAG, "[DIAGNOSTIC] API Call Failed | Endpoint: $endpointName | HTTP Code: ${response.code()} | Message: ${response.message()} | Raw errorBody: $rawErrorBody")
                } else {
                    Log.d(TAG, "[DIAGNOSTIC] API Call HTTP 200 | Endpoint: $endpointName | Body success = false")
                }
            } catch (e: Exception) {
                Log.e(TAG, "[DIAGNOSTIC] Failed to read error body for Endpoint: $endpointName | Exception: ${e::class.java.name}: ${e.message}", e)
            }
        } else if (exception != null) {
            Log.e(TAG, "[DIAGNOSTIC] Retrofit Exception | Endpoint: $endpointName | Exception Class: ${exception::class.java.name} | Message: ${exception.message}", exception)
        }

        if (response != null && response.isSuccessful && response.body() != null) {
            val body = response.body()!!
            when (body) {
                is ValidationResponse -> {
                    if (!body.success) {
                        parsedMessage = body.message
                        parsedHint = body.hint
                        Log.e(TAG, "[DIAGNOSTIC] Parsed Response Error | Endpoint: $endpointName | Message: $parsedMessage | Hint: $parsedHint")
                        return@withContext body.message to body.hint
                    }
                }
                is com.cryptopulse.app.data.api.ConnectExchangeResponse -> {
                    if (!body.success) {
                        parsedMessage = body.message
                        parsedHint = body.hint
                        Log.e(TAG, "[DIAGNOSTIC] Parsed Response Error | Endpoint: $endpointName | Message: $parsedMessage | Hint: $parsedHint")
                        return@withContext body.message to body.hint
                    }
                }
            }
        }

        if (!rawErrorBody.isNullOrBlank()) {
            try {
                val gson = com.google.gson.Gson()
                val json = gson.fromJson(rawErrorBody, com.google.gson.JsonObject::class.java)
                val msg = json.get("message")?.asString
                val hint = json.get("hint")?.asString
                val details = json.get("details")?.asString
                val code = json.get("code")?.asString
                val exchangeCode = json.get("exchangeCode")?.asInt
                
                if (!msg.isNullOrBlank()) {
                    parsedMessage = msg
                    parsedHint = when {
                        !details.isNullOrBlank() -> details
                        !hint.isNullOrBlank() -> hint
                        exchangeCode != null -> "Exchange Code: $exchangeCode"
                        else -> null
                    }
                    Log.e(TAG, "[DIAGNOSTIC] Parsed Error JSON | Endpoint: $endpointName | Message: $parsedMessage | Hint: $parsedHint")
                    return@withContext msg to parsedHint
                }
            } catch (e: Exception) {
                Log.w(TAG, "[DIAGNOSTIC] Could not parse error body as JSON for Endpoint: $endpointName: ${e.message}")
            }
        }

        if (response != null && !response.isSuccessful) {
            val userMsgPair = when (response.code()) {
                400 -> "Invalid request. Please check your API key and secret." to null
                401 -> "Authentication failed. Invalid API key or secret." to null
                403 -> "Access forbidden. Check your IP whitelist or permissions." to null
                404 -> "Exchange endpoint not found. Please check your exchange selection." to null
                429 -> "Rate limit exceeded. Please try again later." to null
                500, 502, 503, 504 -> "Exchange service unavailable. Please try again later." to null
                else -> "Request failed. Please try again." to null
            }
            Log.e(TAG, "[DIAGNOSTIC] Fallback HTTP Code Mapping | Endpoint: $endpointName | HTTP Code: ${response.code()} | User Message: ${userMsgPair.first}")
            return@withContext userMsgPair
        }

        if (exception != null) {
            val exMsgPair = when (exception) {
                is SocketTimeoutException -> "Connection timeout. Please check your internet connection." to null
                is UnknownHostException -> "No internet connection. Please check your network." to null
                is IOException -> "Network error. Please check your internet connection." to null
                else -> "An unexpected error occurred. Please try again." to null
            }
            Log.e(TAG, "[DIAGNOSTIC] Fallback Exception Mapping | Endpoint: $endpointName | Exception Class: ${exception::class.java.name} | User Message: ${exMsgPair.first}")
            return@withContext exMsgPair
        }

        "An unknown error occurred. Please try again." to null
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

            try {
                val validationRequest = ValidateExchangeRequest(
                    exchangeName = state.selectedExchange,
                    apiKey = state.apiKey,
                    apiSecret = state.apiSecret,
                    apiPassphrase = state.apiPassphrase.takeIf { it.isNotBlank() },
                    environment = state.environment,
                )
                val validationResponse = exchangeService.validate(validationRequest)

                if (!validationResponse.isSuccessful || validationResponse.body()?.success != true) {
                    val (userMessage, hint) = getUserFriendlyErrorMessage(endpointName = "/api/exchange/validate", response = validationResponse)
                    Log.e(TAG, "[DIAGNOSTIC] validate failed: message=$userMessage, hint=$hint")
                    _uiState.value = ExchangeUiState.Error(userMessage, hint)
                    _formState.value = _formState.value.copy(isLoading = false, validationMessage = userMessage)
                    return@launch
                }

                Log.d(TAG, "[DIAGNOSTIC] validate success: status=${validationResponse.code()}, body=${validationResponse.body()}")
                _formState.value = _formState.value.copy(validationMessage = "Credentials valid. Connecting...")

                val connectRequest = ConnectExchangeRequest(
                    exchangeName = state.selectedExchange,
                    apiKey = state.apiKey,
                    apiSecret = state.apiSecret,
                    apiPassphrase = state.apiPassphrase.takeIf { it.isNotBlank() },
                    environment = state.environment,
                )
                val connectResponse = exchangeService.connect(connectRequest)

                if (!connectResponse.isSuccessful || connectResponse.body()?.success != true) {
                    val (userMessage, hint) = getUserFriendlyErrorMessage(endpointName = "/api/exchange/connect", response = connectResponse)
                    Log.e(TAG, "[DIAGNOSTIC] connect failed: message=$userMessage, hint=$hint")
                    _uiState.value = ExchangeUiState.Error(userMessage, hint)
                    _formState.value = _formState.value.copy(isLoading = false, validationMessage = userMessage)
                    return@launch
                }

                Log.d(TAG, "[DIAGNOSTIC] connect success: status=${connectResponse.code()}, body=${connectResponse.body()}")
                _formState.value = _formState.value.copy(isLoading = false)
                
                Log.d(TAG, "[DIAGNOSTIC] state update: setting uiState = ExchangeUiState.Connected(${state.selectedExchange})")
                _uiState.value = ExchangeUiState.Connected(state.selectedExchange)

                exchangeConnectionManager.saveConnection(state.selectedExchange, state.environment)

                fetchMarketCandidates()
            } catch (e: Exception) {
                val (userMessage, hint) = getUserFriendlyErrorMessage(endpointName = "/api/exchange/validate-or-connect", exception = e)
                Log.e(TAG, "[DIAGNOSTIC] validate-or-connect exception: message=${e.message}", e)
                _uiState.value = ExchangeUiState.Error(userMessage, hint)
                _formState.value = _formState.value.copy(isLoading = false, validationMessage = userMessage)
            }
        }
    }

    fun fetchMarketCandidates() {
        Log.d(TAG, "[DIAGNOSTIC] fetchMarketCandidates invoked")
        _candidatesError.value = null
        _candidatesLoading.value = true
        _marketDataState.value = MarketDataUiState.Loading
        viewModelScope.launch {
            try {
                val response = marketService.getCandidates()
                if (response.isSuccessful && response.body() != null) {
                    val list = response.body()!!
                    Log.d(TAG, "[DIAGNOSTIC] candidates success: status=${response.code()}, count=${list.size}")
                    
                    Log.d(TAG, "[DIAGNOSTIC] state update: updating _candidates.value with ${list.size} items and setting readyForCandidates = true")
                    _candidates.value = list
                    _readyForCandidates.value = true
                    if (list.isEmpty()) {
                        val emptyMsg = "No market candidates matching volume criteria found on exchange."
                        _candidatesError.value = emptyMsg
                        _marketDataState.value = MarketDataUiState.Empty(emptyMsg)
                    } else {
                        _marketDataState.value = MarketDataUiState.Success(list)
                    }
                } else {
                    val (errMsg, hintMsg) = getUserFriendlyErrorMessage(endpointName = "/api/market/candidates", response = response)
                    Log.e(TAG, "[DIAGNOSTIC] candidates failed: status=${response.code()}, message=$errMsg")
                    _candidatesError.value = errMsg
                    _marketDataState.value = MarketDataUiState.Error(errMsg, hintMsg)
                }
            } catch (e: Exception) {
                val (errMsg, hintMsg) = getUserFriendlyErrorMessage(endpointName = "/api/market/candidates", exception = e)
                Log.e(TAG, "[DIAGNOSTIC] candidates exception: message=${e.message}", e)
                _candidatesError.value = errMsg
                _marketDataState.value = MarketDataUiState.Error(errMsg, hintMsg)
            } finally {
                _candidatesLoading.value = false
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
                    _analysisError.value = getUserFriendlyErrorMessage(endpointName = "/api/market/technical-analysis", response = response).first
                }
            } catch (e: Exception) {
                _analysisError.value = getUserFriendlyErrorMessage(endpointName = "/api/market/technical-analysis", exception = e).first
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
        viewModelScope.launch {
            try {
                val symbol = _selectedCandidate.value?.symbol ?: return@launch
                val result = klineService.getKlines(symbol, interval, limit)
                if (result.isSuccessful && result.body() != null) {
                    _klines.value = result.body()!!
                } else {
                    result.errorBody()?.close()
                }
            } catch (e: Exception) {
                // Ignore silent failures for klines update loop
            }
        }
    }

    fun fetchBalances() {
        viewModelScope.launch {
            try {
                val response = exchangeService.getBalance()
                if (response.isSuccessful) {
                    val body = response.body()
                    if (body != null && body.success) {
                        _balances.value = body.balances ?: emptyList()
                        _balancesError.value = null
                    } else {
                        _balancesError.value = body?.message ?: "Failed to fetch balances"
                    }
                } else {
                    response.errorBody()?.close()
                    _balancesError.value = "Server error: ${response.code()}"
                }
            } catch (e: Exception) {
                _balancesError.value = "Network error: ${e.message}"
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
        com.cryptopulse.app.service.TradeAlertManager.getInstance(appContext).dismissOrExecuteAlert()
        val alertId = _pendingAlert.value?.get("id") as? String
        if (alertId != null) {
            viewModelScope.launch {
                try {
                    val token = tokenManager.getToken()
                    if (token != null) {
                        val res = tradingBotService.acknowledgeAlert(mapOf("alertId" to alertId))
                        if (!res.isSuccessful) {
                            res.errorBody()?.close()
                        }
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
                                val ackRes = tradingBotService.acknowledgeAlert(mapOf("alertId" to alertId))
                                if (!ackRes.isSuccessful) {
                                    ackRes.errorBody()?.close()
                                }
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
                        _tradeError.value = getUserFriendlyErrorMessage(endpointName = "/api/trading-bot/execute-trade", response = response).first
                    }
                } else {
                    _tradeError.value = "Your session has expired. Please sign in again."
                }
            } catch (e: Exception) {
                _tradeError.value = getUserFriendlyErrorMessage(endpointName = "/api/trading-bot/execute-trade", exception = e).first
            }
        }
    }

    fun activateBot(symbol: String, strategy: String, config: Map<String, Any>? = null) {
        _botError.value = null
        val targetPrice = sessionRepository.tradeSetupConfig.value?.entryPrice?.takeIf { it > 0.0 }
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
                        _botError.value = getUserFriendlyErrorMessage(endpointName = "/api/trading-bot/activate", response = response).first
                    }
                }
            } catch (e: Exception) {
                _botError.value = getUserFriendlyErrorMessage(endpointName = "/api/trading-bot/activate", exception = e).first
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

    companion object {
        private const val TAG = "ExchangeViewModel"
    }
}