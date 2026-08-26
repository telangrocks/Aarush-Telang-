package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.*
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.domain.models.SymbolTradingRules
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.ui.screens.MarketCandidate
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

import com.cryptopulse.app.domain.models.EntryIntent
import java.util.Locale

data class TradeSetupUiState(
    val isLoading: Boolean = false,
    val error: String? = null,
    val currentSymbol: String? = null,
    val isEntryPriceManuallyEdited: Boolean = false,
    val entryPrice: String = "",
    val entryPriceError: String? = null,
    val selectedEntryIntent: EntryIntent = EntryIntent.WAIT_FOR_PRICE,
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

@HiltViewModel
class TradeSetupViewModel @Inject constructor(
    private val sessionRepository: TradeSessionRepository,
    private val exchangeRepository: com.cryptopulse.app.domain.repository.ExchangeRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(TradeSetupUiState())
    val uiState: StateFlow<TradeSetupUiState> = _uiState.asStateFlow()

    private fun formatPriceToTickSize(price: Double, tickSize: Double?): String {
        if (price <= 0.0) return ""
        if (tickSize == null || tickSize >= 1.0) {
            return String.format(Locale.US, "%.2f", price)
        }
        val tickStr = java.math.BigDecimal.valueOf(tickSize).stripTrailingZeros().toPlainString()
        val decimals = if (tickStr.contains(".")) tickStr.substringAfter(".").length else 2
        return String.format(Locale.US, "%.${decimals}f", price)
    }

    fun setConstraints(
        candidate: MarketCandidate,
        exchangeName: String
    ) {
        _uiState.update { currentState ->
            val isNewSymbol = currentState.currentSymbol != candidate.symbol
            val initialEntryPrice = if (isNewSymbol && (!currentState.isEntryPriceManuallyEdited || currentState.entryPrice.isBlank())) {
                formatPriceToTickSize(candidate.currentMarketPrice, candidate.tickSize)
            } else {
                currentState.entryPrice
            }

            val updatedState = currentState.copy(
                currentSymbol = candidate.symbol,
                entryPrice = initialEntryPrice,
                isEntryPriceManuallyEdited = if (isNewSymbol) false else currentState.isEntryPriceManuallyEdited,
                minNotional = candidate.minNotional,
                minOrderQty = candidate.minOrderQty,
                qtyStep = candidate.qtyStep,
                tickSize = candidate.tickSize,
                minPrice = candidate.minPrice,
                maxPrice = candidate.maxPrice,
                maxQty = candidate.maxQty
            )
            val rules = buildRules(updatedState, candidate, exchangeName)
            val valRes = validateEntryPriceOnly(updatedState.entryPrice, candidate.currentMarketPrice, rules)
            updatedState.copy(
                entryPriceError = if (updatedState.entryPrice.isNotBlank() && !valRes.isValid) valRes.errorMessage else null
            )
        }
    }

    private fun buildRules(
        state: TradeSetupUiState,
        candidate: MarketCandidate,
        exchangeName: String
    ): SymbolTradingRules {
        val parts = candidate.pairName.split("/")
        val baseAsset = if (parts.size >= 2) parts[0] else candidate.symbol
        val quoteAsset = if (parts.size >= 2) parts[1] else "USDT"

        return SymbolTradingRules(
            symbol = candidate.symbol,
            exchange = exchangeName,
            baseAsset = baseAsset,
            quoteAsset = quoteAsset,
            minNotional = state.minNotional,
            minQty = state.minOrderQty,
            maxQty = state.maxQty,
            stepSize = state.qtyStep,
            tickSize = state.tickSize,
            minPrice = state.minPrice,
            maxPrice = state.maxPrice
        )
    }

    fun updateEntryIntent(intent: EntryIntent) {
        _uiState.update { it.copy(selectedEntryIntent = intent) }
    }

    fun updateEntryPrice(value: String, candidate: MarketCandidate, exchangeName: String) {
        _uiState.update { currentState ->
            val rules = buildRules(currentState, candidate, exchangeName)
            val valRes = validateEntryPriceOnly(value, candidate.currentMarketPrice, rules)
            val err = if (value.isBlank()) "Entry price is required." else if (!valRes.isValid) valRes.errorMessage else null
            currentState.copy(
                entryPrice = value,
                isEntryPriceManuallyEdited = true,
                entryPriceError = err
            )
        }
    }

    private fun validateEntryPriceOnly(
        entryPriceStr: String,
        currentMarketPrice: Double,
        rules: SymbolTradingRules
    ): com.cryptopulse.app.domain.validation.TradeValidationResult {
        return com.cryptopulse.app.domain.validation.TradeValidator.validate(
            params = com.cryptopulse.app.domain.validation.TradeValidationParams(
                symbol = rules.symbol,
                entryPriceStr = entryPriceStr,
                currentMarketPrice = currentMarketPrice,
                tradeValueUsdt = null,
                quantity = null
            ),
            rules = rules
        )
    }

    suspend fun validateAndConfirmTrade(
        strategyId: String? = null,
        candidate: MarketCandidate,
        exchangeName: String,
        availableBalance: Double?
    ): TradeSetupConfigResult {
        _uiState.update { it.copy(isLoading = true, error = null) }

        val currentState = _uiState.value
        val rules = buildRules(currentState, candidate, exchangeName)
        
        val valRes = validateEntryPriceOnly(currentState.entryPrice, candidate.currentMarketPrice, rules)
        val entryPriceError = if (currentState.entryPrice.isBlank()) "Entry price is required." else if (!valRes.isValid) valRes.errorMessage else null

        if (entryPriceError != null) {
            _uiState.update { it.copy(entryPriceError = entryPriceError, isLoading = false) }
            return TradeSetupConfigResult.ValidationFailed(mapOf("entryPrice" to entryPriceError))
        }

        val quoteAsset = rules.quoteAsset
        val bal = availableBalance ?: 0.0

        // Perform a very basic check (for deeper checks we would need quantity/trade value setup)
        // Here we just ensure we have *some* balance. Real notional check happens later.
        if (bal <= 0.0) {
            _uiState.update { it.copy(error = "Insufficient $quoteAsset balance for trade.", isLoading = false) }
            return TradeSetupConfigResult.ValidationFailed(mapOf("balance" to "Insufficient balance"))
        }

        val config = TradeSetupConfig(
            strategyId = strategyId,
            symbol = candidate.symbol,
            entryPrice = currentState.entryPrice.toDouble(),
            tradeValueUsdt = null,
            parameters = emptyMap(),
            entryIntent = currentState.selectedEntryIntent
        )
        sessionRepository.setTradeSetupConfig(config)
        _uiState.update { it.copy(isLoading = false) }
        return TradeSetupConfigResult.Success(config)
    }
}






