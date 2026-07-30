package com.cryptopulse.app.ui.strategies

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.repository.StrategyRepository
import com.cryptopulse.app.data.repository.TradeSessionRepository
import com.cryptopulse.app.domain.models.DynamicFieldModel
import com.cryptopulse.app.domain.models.SymbolTradingRules
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.domain.models.toDynamicFieldModel
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class TradeSetupUiState(
    val isLoading: Boolean = true,
    val error: String? = null,
    val fields: List<DynamicFieldModel> = emptyList(),
    val formValues: Map<String, String> = emptyMap(),
    val formErrors: Map<String, String?> = emptyMap(),
    val entryPrice: String = "",
    val entryPriceError: String? = null,
    val tradeValueUsdt: String = "",
    val tradeValueUsdtError: String? = null,
    val minNotional: Double = 0.0
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
    private val repository: StrategyRepository,
    private val sessionRepository: TradeSessionRepository,
    private val exchangeService: com.cryptopulse.app.data.api.ExchangeService
) : ViewModel() {

    private val _uiState = MutableStateFlow(TradeSetupUiState())
    val uiState: StateFlow<TradeSetupUiState> = _uiState.asStateFlow()

    private val _balanceState = MutableStateFlow<BalanceUiState>(BalanceUiState.Loading)
    val balanceState: StateFlow<BalanceUiState> = _balanceState.asStateFlow()

    init {
        loadStrategySchema()
        loadBalance()
    }

    fun loadBalance() {
        viewModelScope.launch {
            _balanceState.value = BalanceUiState.Loading
            try {
                val response = exchangeService.getBalance()
                if (!response.isSuccessful) {
                    response.errorBody()?.close()
                    _balanceState.value = BalanceUiState.Error("Failed to fetch exchange balance (${response.code()})")
                    return@launch
                }

                val body = response.body()
                if (body == null) {
                    _balanceState.value = BalanceUiState.Error("Empty response from exchange service.")
                    return@launch
                }

                if (!body.success) {
                    if (body.code == "NO_EXCHANGE_CONNECTED") {
                        _balanceState.value = BalanceUiState.NotConnected
                    } else {
                        _balanceState.value = BalanceUiState.Error(body.message ?: "Failed to fetch balance.", body.code)
                    }
                    return@launch
                }

                val primaryAsset = body.primaryAsset ?: "USDT"
                val balances = body.balances ?: emptyList()
                val primaryItem = balances.find { it.asset.equals(primaryAsset, ignoreCase = true) }
                
                val free = primaryItem?.free ?: 0.0
                val total = primaryItem?.total ?: 0.0
                val exchange = body.exchange?.replaceFirstChar { it.uppercase() } ?: "Exchange"
                val env = body.environment?.replaceFirstChar { it.uppercase() } ?: "Mainnet"

                _balanceState.value = BalanceUiState.Success(
                    primaryAsset = primaryAsset.uppercase(),
                    freeBalance = free,
                    totalBalance = total,
                    exchangeName = exchange,
                    environment = env
                )
            } catch (e: Exception) {
                _balanceState.value = BalanceUiState.Error(e.message ?: "Network error fetching balance.")
            }
        }
    }

    private fun loadStrategySchema() {
        val strategyId = sessionRepository.selectedStrategyId.value
        if (strategyId == null) {
            _uiState.update { it.copy(isLoading = false, error = "Strategy ID is missing.") }
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            repository.getStrategyById(strategyId).onSuccess { strategy ->
                if (strategy == null) {
                    _uiState.update { it.copy(isLoading = false, error = "Strategy not found.") }
                } else {
                    val fields = strategy.requiredParameters.map { it.toDynamicFieldModel() }
                    
                    val initialValues = mutableMapOf<String, String>()
                    fields.forEach { field ->
                        initialValues[field.key] = field.defaultValue
                    }
                    _uiState.update { 
                        it.copy(
                            isLoading = false,
                            fields = fields,
                            formValues = initialValues
                        )
                    }
                }
            }.onFailure { error ->
                _uiState.update { it.copy(isLoading = false, error = error.message ?: "Failed to load schema.") }
            }
        }
    }

    fun updateFieldValue(key: String, value: String) {
        _uiState.update { currentState ->
            val updatedValues = currentState.formValues.toMutableMap().apply { put(key, value) }
            val newError = validateField(key, value, currentState.fields)
            val updatedErrors = currentState.formErrors.toMutableMap().apply { put(key, newError) }
            currentState.copy(formValues = updatedValues, formErrors = updatedErrors)
        }
    }

    fun setMinNotional(minNotional: Double) {
        _uiState.update { currentState ->
            val rules = SymbolTradingRules(
                symbol = "SYMBOL",
                exchange = "exchange",
                baseAsset = "BASE",
                quoteAsset = "USDT",
                minNotional = minNotional,
                minQty = 0.00001,
                maxQty = 1000000.0,
                stepSize = 0.00001,
                tickSize = 0.01,
                minPrice = 0.01,
                maxPrice = 1000000.0
            )
            val valRes = validateEntryPriceOnly(currentState.entryPrice, rules)
            currentState.copy(
                minNotional = minNotional,
                entryPriceError = if (currentState.entryPrice.isNotBlank() && !valRes.isValid) valRes.errorMessage else null
            )
        }
    }

    fun updateEntryPrice(value: String) {
        _uiState.update { currentState ->
            val rules = SymbolTradingRules(
                symbol = "SYMBOL",
                exchange = "exchange",
                baseAsset = "BASE",
                quoteAsset = "USDT",
                minNotional = currentState.minNotional,
                minQty = 0.00001,
                maxQty = 1000000.0,
                stepSize = 0.00001,
                tickSize = 0.01,
                minPrice = 0.01,
                maxPrice = 1000000.0
            )
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
                tradeValueUsdt = 100.0 // Dummy notional passed solely to validate entry price limits & tick size without triggering trade value missing errors
            ),
            rules = rules
        )
    }

    private fun validateField(key: String, value: String, fields: List<DynamicFieldModel>): String? {
        val field = fields.find { it.key == key } ?: return null
        var error: String? = null

        if (field.isRequired && value.isBlank()) {
            error = "This field is required."
        } else if (value.isNotBlank()) {
            when (field.type) {
                com.cryptopulse.app.domain.models.ParameterType.INT -> {
                    val intVal = value.toIntOrNull()
                    if (intVal == null) {
                        error = "Must be a valid integer."
                    } else {
                        field.minValue?.let { min -> if (intVal < min) error = "Min is $min" }
                        field.maxValue?.let { max -> if (intVal > max) error = "Max is $max" }
                    }
                }
                com.cryptopulse.app.domain.models.ParameterType.DOUBLE -> {
                    val doubleVal = value.toDoubleOrNull()
                    if (doubleVal == null) {
                        error = "Must be a valid number."
                    } else {
                        field.minValue?.let { min -> if (doubleVal < min) error = "Min is $min" }
                        field.maxValue?.let { max -> if (doubleVal > max) error = "Max is $max" }
                    }
                }
                com.cryptopulse.app.domain.models.ParameterType.BOOLEAN -> {}
                com.cryptopulse.app.domain.models.ParameterType.ENUM -> {
                    if (field.options?.contains(value) != true) {
                        error = "Invalid option."
                    }
                }
            }
        }
        return error
    }

    fun buildConfig(symbol: String): TradeSetupConfigResult {
        val currentState = _uiState.value
        var hasErrors = false
        val newErrors = currentState.formErrors.toMutableMap()
        val finalErrors = mutableMapOf<String, String>()

        val rules = SymbolTradingRules(
            symbol = symbol,
            exchange = "exchange",
            baseAsset = symbol,
            quoteAsset = "USDT",
            minNotional = currentState.minNotional,
            minQty = 0.00001,
            maxQty = 1000000.0,
            stepSize = 0.00001,
            tickSize = 0.01,
            minPrice = 0.01,
            maxPrice = 1000000.0
        )
        val valRes = validateEntryPriceOnly(currentState.entryPrice, rules)
        val entryPriceError = if (currentState.entryPrice.isBlank()) "Entry price is required." else if (!valRes.isValid) valRes.errorMessage else null

        newErrors["entryPrice"] = entryPriceError
        if (entryPriceError != null) {
            hasErrors = true
            finalErrors["entryPrice"] = entryPriceError
        }

        currentState.fields.forEach { field ->
            val value = currentState.formValues[field.key] ?: field.defaultValue
            val error = validateField(field.key, value, currentState.fields)
            newErrors[field.key] = error
            if (error != null) {
                hasErrors = true
                finalErrors[field.key] = error
            }
        }
        
        if (hasErrors) {
            _uiState.update { it.copy(formErrors = newErrors, entryPriceError = entryPriceError) }
            return TradeSetupConfigResult.ValidationFailed(finalErrors)
        }

        val config = TradeSetupConfig(
            strategyId = sessionRepository.selectedStrategyId.value!!,
            symbol = symbol,
            entryPrice = currentState.entryPrice.toDouble(),
            tradeValueUsdt = 0.0, // Legacy non-null property in TradeSetupConfig data model; mapped to positionSize = null prior to /bot/activate
            parameters = currentState.formValues
        )
        sessionRepository.setTradeSetupConfig(config)
        return TradeSetupConfigResult.Success(config)
    }
}
