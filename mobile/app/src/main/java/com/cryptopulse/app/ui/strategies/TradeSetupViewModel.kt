package com.cryptopulse.app.ui.strategies

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.repository.StrategyRepository
import com.cryptopulse.app.data.repository.TradeSessionRepository
import com.cryptopulse.app.domain.models.DynamicFieldModel
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
    val entryPriceError: String? = null
)

sealed interface TradeSetupConfigResult {
    data class Success(val config: TradeSetupConfig) : TradeSetupConfigResult
    data class ValidationFailed(val errors: Map<String, String>) : TradeSetupConfigResult
}

@HiltViewModel
class TradeSetupViewModel @Inject constructor(
    private val repository: StrategyRepository,
    private val sessionRepository: TradeSessionRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(TradeSetupUiState())
    val uiState: StateFlow<TradeSetupUiState> = _uiState.asStateFlow()

    init {
        loadStrategySchema()
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

    fun updateEntryPrice(value: String) {
        val error = validateEntryPrice(value)
        _uiState.update { it.copy(entryPrice = value, entryPriceError = error) }
    }

    private fun validateEntryPrice(value: String): String? {
        if (value.isBlank()) return "Entry price is required."
        val doubleVal = value.toDoubleOrNull() ?: return "Must be a valid number."
        if (doubleVal <= 0.0) return "Entry price must be greater than 0."
        return null
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

        val entryPriceError = validateEntryPrice(currentState.entryPrice)
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
            parameters = currentState.formValues
        )
        sessionRepository.setTradeSetupConfig(config)
        return TradeSetupConfigResult.Success(config)
    }
}
