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
import javax.inject.Inject

sealed class ExchangeUiState {
    object Idle : ExchangeUiState()
    object Validating : ExchangeUiState()
    object Connecting : ExchangeUiState()
    data class Connected(val exchangeName: String) : ExchangeUiState()
    data class Error(val message: String) : ExchangeUiState()
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
    val positionSize: Double = 0.0,
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

    private val _strategies = MutableStateFlow<List<StrategyDto>>(emptyList())
    val strategies: StateFlow<List<StrategyDto>> = _strategies

    private val _selectedStrategy = MutableStateFlow<String?>(null)
    val selectedStrategy: StateFlow<String?> = _selectedStrategy

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

    private val _positions = MutableStateFlow<List<Map<String, Any>>>(emptyList())
    val positions: StateFlow<List<Map<String, Any>>> = _positions

    fun fetchPositions() {
        viewModelScope.launch {
            try {
                val token = tokenManager.getToken()
                if (token != null) {
                    val response = tradingBotService.getPositions()
                    if (response.isSuccessful && response.body() != null) {
                        _positions.value = response.body()!!.map { it as Map<String, Any> }
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
                    val msg = validationResponse.body()?.message ?: "Validation failed"
                    _uiState.value = ExchangeUiState.Error(msg)
                    _formState.value = _formState.value.copy(isLoading = false, validationMessage = msg)
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
                    val msg = connectResponse.body()?.message ?: "Connection failed"
                    _uiState.value = ExchangeUiState.Error(msg)
                    _formState.value = _formState.value.copy(isLoading = false, validationMessage = msg)
                    return@launch
                }

                _formState.value = _formState.value.copy(isLoading = false)
                _uiState.value = ExchangeUiState.Connected(state.selectedExchange)

                fetchMarketCandidates()
            } catch (e: Exception) {
                val msg = e.localizedMessage ?: "Network error"
                _uiState.value = ExchangeUiState.Error(msg)
                _formState.value = _formState.value.copy(isLoading = false, validationMessage = msg)
            }
        }
    }

    fun fetchMarketCandidates() {
        viewModelScope.launch {
            try {
                val response = marketService.getCandidates()
                if (response.isSuccessful && response.body() != null) {
                    _candidates.value = response.body()!!
                    _readyForCandidates.value = true
                }
            } catch (e: Exception) {
                // Silently fail - user can retry
            }
        }
    }

    fun resetState() {
        _uiState.value = ExchangeUiState.Idle
        _formState.value = ExchangeFormState()
        _candidates.value = emptyList()
        _readyForCandidates.value = false
        _selectedCandidate.value = null
        _strategies.value = emptyList()
        _selectedStrategy.value = null
        _technicalAnalysis.value = null
        _tradeSetup.value = null
        _ticker.value = null
    }

    fun setTradeSetup(entryPrice: Double, stopLoss: Double, takeProfit: Double, positionSize: Double) {
        _tradeSetup.value = TradeSetupState(entryPrice, stopLoss, takeProfit, positionSize)
    }

    fun selectCandidate(candidate: MarketCandidate) {
        _selectedCandidate.value = candidate
    }

    fun fetchStrategies() {
        viewModelScope.launch {
            try {
                val response = strategyService.getStrategies()
                if (response.isSuccessful && response.body() != null) {
                    _strategies.value = response.body()!!
                }
            } catch (e: Exception) {
                // Silently fail
            }
        }
    }

    fun selectStrategy(strategyId: String) {
        _selectedStrategy.value = strategyId
    }

    fun fetchTechnicalAnalysis() {
        val candidate = _selectedCandidate.value ?: return
        val strategy = _selectedStrategy.value ?: return

        viewModelScope.launch {
            try {
                val response = technicalAnalysisService.getAnalysis(
                    TechnicalAnalysisRequest(
                        symbol = candidate.symbol,
                        strategy = strategy,
                    )
                )
                if (response.isSuccessful && response.body() != null) {
                    _technicalAnalysis.value = response.body()
                }
            } catch (e: Exception) {
                // Silently fail
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
        val candidate = _selectedCandidate.value ?: return
        val alert = _pendingAlert.value ?: return
        val tradeSetup = _tradeSetup.value

        viewModelScope.launch {
            try {
                val token = tokenManager.getToken()
                if (token != null) {
                    val response = tradingBotService.executeTrade()
                    if (response.isSuccessful) {
                        val alertId = alert["id"] as? String
                        if (alertId != null) {
                            tradingBotService.acknowledgeAlert(mapOf("alertId" to alertId))
                        }
                        _pendingAlert.value = null
                        if (tradeSetup != null) {
                            _lastTrade.value = tradeSetup
                        }
                    }
                }
            } catch (e: Exception) {
                // Silently fail
            }
        }
    }

    fun activateBot(symbol: String, strategy: String) {
        viewModelScope.launch {
            try {
                val token = tokenManager.getToken()
                if (token != null) {
                    tradingBotService.activate(
                        ActivateBotRequest(
                            coinId = symbol,
                            strategy = strategy,
                        )
                    )
                }
            } catch (e: Exception) {
                // Silently fail
            }
        }
    }

    fun registerFcmToken(fcmToken: String) {
        viewModelScope.launch {
            try {
                val token = tokenManager.getToken()
                if (token != null) {
                    val request = mapOf("fcmToken" to fcmToken)
                    fcmApi.registerToken("Bearer $token", request)
                }
            } catch (e: Exception) {
                // Silently fail
            }
        }
    }
}
