package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.*
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.domain.models.SymbolTradingRules
import com.cryptopulse.app.domain.models.TradeSetupConfig
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class TradeSetupUiState(
    val isLoading: Boolean = false,
    val error: String? = null,
    val entryPrice: String = "",
    val entryPriceError: String? = null,
    val minNotional: Double? = null,
    val minOrderQty: Double? = null,
    val qtyStep: Double? = null,
    val tickSize: Double? = null,
    val minPrice: Double? = null,
    val maxPrice: Double? = null,
    val maxQty: Double? = null
)

sealed interface TradeSetupConfigResult {
    data class Success(val config: TradeSetupConfig) : TradeSetupConfigResult
    data class ValidationFailed(val errors: Map<String, String>) : TradeSetupConfigResult
}

sealed interface BalanceUiState {
    object Loading : BalanceUiState
    data class Success(
        val primaryAsset: String,
        val freeBalance: Double,
        val totalBalance: Double,
        val exchangeName: String,
        val environment: String
    ) : BalanceUiState
    data class Error(val message: String, val code: String? = null) : BalanceUiState
    object NotConnected : BalanceUiState
}

@HiltViewModel
class TradeSetupViewModel @Inject constructor(
    private val sessionRepository: TradeSessionRepository,
    private val exchangeRepository: com.cryptopulse.app.domain.repository.ExchangeRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(TradeSetupUiState())
    val uiState: StateFlow<TradeSetupUiState> = _uiState.asStateFlow()

    private val _balanceState = MutableStateFlow<BalanceUiState>(BalanceUiState.Loading)
    val balanceState: StateFlow<BalanceUiState> = _balanceState.asStateFlow()

    init {
        loadBalance()
    }

    fun loadBalance() {
        viewModelScope.launch {
            _balanceState.value = BalanceUiState.Loading

            val statusResult = exchangeRepository.getConnectionStatus()
            val (exchangeName, environmentName) = if (statusResult is NetworkResult.Success) {
                val status = statusResult.data
                (status.exchangeName?.replaceFirstChar { it.uppercase() } ?: "Exchange") to (status.environment?.replaceFirstChar { it.uppercase() } ?: "Mainnet")
            } else {
                "Exchange" to "Mainnet"
            }
            
            val result = exchangeRepository.getBalances()
            result.onSuccess { body ->
                val primaryAsset = "USDT"
                val balances = body
                val primaryItem = balances.find { it.asset.equals(primaryAsset, ignoreCase = true) }
                
                val free = primaryItem?.free ?: 0.0
                val total = primaryItem?.total ?: 0.0

                _balanceState.value = BalanceUiState.Success(
                    primaryAsset = primaryAsset.uppercase(),
                    freeBalance = free,
                    totalBalance = total,
                    exchangeName = exchangeName,
                    environment = environmentName
                )
            }.onFailure { e ->
                if (e is com.cryptopulse.app.domain.models.DomainException && e.code == "NO_EXCHANGE_CONNECTED") {
                    _balanceState.value = BalanceUiState.NotConnected
                } else {
                    _balanceState.value = BalanceUiState.Error(e.message ?: "Failed to fetch balance.")
                }
            }
        }
    }

    fun setConstraints(
        minNotional: Double?,
        minOrderQty: Double?,
        qtyStep: Double?,
        tickSize: Double?,
        minPrice: Double?,
        maxPrice: Double?,
        maxQty: Double?
    ) {
        _uiState.update { currentState ->
            val updatedState = currentState.copy(
                minNotional = minNotional,
                minOrderQty = minOrderQty,
                qtyStep = qtyStep,
                tickSize = tickSize,
                minPrice = minPrice,
                maxPrice = maxPrice,
                maxQty = maxQty
            )
            val rules = buildRules(updatedState)
            val valRes = validateEntryPriceOnly(currentState.entryPrice, rules)
            updatedState.copy(
                entryPriceError = if (currentState.entryPrice.isNotBlank() && !valRes.isValid) valRes.errorMessage else null
            )
        }
    }

    private fun buildRules(state: TradeSetupUiState, symbol: String = "SYMBOL"): SymbolTradingRules {
        return SymbolTradingRules(
            symbol = symbol,
            exchange = "exchange",
            baseAsset = symbol,
            quoteAsset = "USDT",
            minNotional = state.minNotional,
            minQty = state.minOrderQty,
            maxQty = state.maxQty,
            stepSize = state.qtyStep,
            tickSize = state.tickSize,
            minPrice = state.minPrice,
            maxPrice = state.maxPrice
        )
    }

    fun updateEntryPrice(value: String) {
        _uiState.update { currentState ->
            val rules = buildRules(currentState)
            val valRes = validateEntryPriceOnly(value, rules)
            val err = if (value.isBlank()) "Entry price is required." else if (!valRes.isValid) valRes.errorMessage else null
            currentState.copy(entryPrice = value, entryPriceError = err)
        }
    }

    private fun validateEntryPriceOnly(
        entryPriceStr: String,
        rules: SymbolTradingRules
    ): com.cryptopulse.app.domain.validation.TradeValidationResult {
        val price = entryPriceStr.toDoubleOrNull() ?: 0.0
        return com.cryptopulse.app.domain.validation.TradeValidator.validate(
            params = com.cryptopulse.app.domain.validation.TradeValidationParams(
                symbol = rules.symbol,
                entryPrice = price,
                tradeValueUsdt = null,
                quantity = null
            ),
            rules = rules
        )
    }

    fun buildConfig(symbol: String): TradeSetupConfigResult {
        val currentState = _uiState.value
        val rules = buildRules(currentState, symbol)
        
        val valRes = validateEntryPriceOnly(currentState.entryPrice, rules)
        val entryPriceError = if (currentState.entryPrice.isBlank()) "Entry price is required." else if (!valRes.isValid) valRes.errorMessage else null

        if (entryPriceError != null) {
            _uiState.update { it.copy(entryPriceError = entryPriceError) }
            return TradeSetupConfigResult.ValidationFailed(mapOf("entryPrice" to entryPriceError))
        }

        val config = TradeSetupConfig(
            strategyId = null,
            symbol = symbol,
            entryPrice = currentState.entryPrice.toDouble(),
            tradeValueUsdt = null,
            parameters = emptyMap()
        )
        sessionRepository.setTradeSetupConfig(config)
        return TradeSetupConfigResult.Success(config)
    }
}






