package com.cryptopulse.app.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.api.ConnectExchangeRequest
import com.cryptopulse.app.data.api.ExchangeService
import com.cryptopulse.app.data.api.MarketCandidateDto
import com.cryptopulse.app.data.api.MarketService
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
    val apiKey: String = "",
    val apiSecret: String = "",
    val apiKeyError: String? = null,
    val apiSecretError: String? = null,
    val isLoading: Boolean = false,
    val validationMessage: String? = null,
)

@HiltViewModel
class ExchangeViewModel @Inject constructor(
    private val exchangeService: ExchangeService,
    private val marketService: MarketService,
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

    fun onExchangeSelected(exchange: String) {
        _formState.value = _formState.value.copy(selectedExchange = exchange)
    }

    fun onApiKeyChanged(apiKey: String) {
        _formState.value = _formState.value.copy(apiKey = apiKey, apiKeyError = null)
    }

    fun onApiSecretChanged(apiSecret: String) {
        _formState.value = _formState.value.copy(apiSecret = apiSecret, apiSecretError = null)
    }

    fun validateAndConnect() {
        val state = _formState.value
        var hasError = false

        if (state.apiKey.isBlank()) {
            _formState.value = state.copy(apiKeyError = "API Key is required")
            hasError = true
        }
        if (state.apiSecret.isBlank()) {
            _formState.value = state.copy(apiSecretError = "API Secret is required")
            hasError = true
        }
        if (hasError) return

        viewModelScope.launch {
            _uiState.value = ExchangeUiState.Validating
            _formState.value = _formState.value.copy(isLoading = true, validationMessage = null)

            try {
                val validationRequest = ValidateExchangeRequest(
                    exchangeName = state.selectedExchange,
                    apiKey = state.apiKey,
                    apiSecret = state.apiSecret,
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
    }

    fun selectCandidate(candidate: MarketCandidate) {
        _selectedCandidate.value = candidate
    }
}
