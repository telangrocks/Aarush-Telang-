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
    val tradeAmountUsdt: String = "5.00",
    val tradeAmountError: String? = null,
    val previewPrice: Double = 0.0,
    val isEntryPriceManuallyEdited: Boolean = false,
    val entryPrice: String = "",
    val entryPriceError: String? = null,
    val selectedEntryIntent: EntryIntent = EntryIntent.IMMEDIATE,
    val minNotional: Double? = null,
    val minOrderQty: Double? = null,
    val qtyStep: Double? = null,
    val tickSize: Double? = null,
    val minPrice: Double? = null,
    val maxPrice: Double? = null,
    val maxQty: Double? = null,
    val atrTakeProfitMultiplier: Double? = null,
    val atrStopLossMultiplier: Double? = null
) {
    @Deprecated("Use atrTakeProfitMultiplier under Model A", ReplaceWith("atrTakeProfitMultiplier"))
    val riskRewardRatio: Double? get() = atrTakeProfitMultiplier
}

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
            currentState.copy(
                currentSymbol = candidate.symbol,
                previewPrice = candidate.currentMarketPrice,
                entryPrice = "", // Clean: no coin price pre-population
                entryPriceError = null, // Clean: no coin metadata error in trade setup
                tradeAmountUsdt = if (currentState.tradeAmountUsdt.isNotBlank()) currentState.tradeAmountUsdt else "5.00",
                tradeAmountError = null,
                isEntryPriceManuallyEdited = false,
                minNotional = candidate.minNotional,
                minOrderQty = candidate.minOrderQty,
                qtyStep = candidate.qtyStep,
                tickSize = candidate.tickSize,
                minPrice = candidate.minPrice,
                maxPrice = candidate.maxPrice,
                maxQty = candidate.maxQty
            )
        }
    }

    fun updateTradeAmount(value: String, availableBalance: Double? = null) {
        _uiState.update { currentState ->
            val trimmed = value.trim()
            val parsed = trimmed.toDoubleOrNull()
            val error = when {
                trimmed.isBlank() -> "Trade amount is required."
                parsed == null || parsed <= 0.0 -> "Trade amount must be a positive number."
                availableBalance != null && availableBalance > 0.0 && parsed > availableBalance ->
                    "Trade amount exceeds available balance (${String.format(Locale.US, "%.2f", availableBalance)} USDT)."
                else -> null
            }
            currentState.copy(
                tradeAmountUsdt = value,
                tradeAmountError = error
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
            currentState.copy(
                entryPrice = value,
                isEntryPriceManuallyEdited = true,
                entryPriceError = null
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

    fun updateAtrTakeProfit(value: Double) {
        val clamped = value.coerceIn(1.0, 5.0)
        _uiState.update { it.copy(atrTakeProfitMultiplier = clamped) }
    }

    @Deprecated("Use updateAtrTakeProfit under Model A", ReplaceWith("updateAtrTakeProfit(value)"))
    fun updateRiskReward(value: Double) {
        updateAtrTakeProfit(value)
    }

    fun updateAtrStopLoss(value: Double) {
        val clamped = value.coerceIn(0.5, 5.0)
        _uiState.update { it.copy(atrStopLossMultiplier = clamped) }
    }

    fun resetRiskParameters() {
        _uiState.update { it.copy(atrTakeProfitMultiplier = null, atrStopLossMultiplier = null) }
    }

    suspend fun validateAndConfirmTrade(
        strategyId: String? = null,
        candidate: MarketCandidate? = null,
        exchangeName: String,
        availableBalance: Double?
    ): TradeSetupConfigResult {
        _uiState.update { it.copy(isLoading = true, error = null) }

        val currentState = _uiState.value
        val quoteAsset = candidate?.let {
            val parts = it.pairName.split("/")
            if (parts.size >= 2) parts[1] else "USDT"
        } ?: "USDT"
        val bal = availableBalance ?: 0.0

        val tradeAmount = currentState.tradeAmountUsdt.trim().toDoubleOrNull()
        if (tradeAmount == null || tradeAmount <= 0.0) {
            val err = "Trade amount must be a positive number."
            _uiState.update { it.copy(tradeAmountError = err, isLoading = false) }
            return TradeSetupConfigResult.ValidationFailed(mapOf("tradeAmount" to err))
        }

        if (bal <= 0.0) {
            val err = "Insufficient $quoteAsset balance for trade."
            _uiState.update { it.copy(error = err, isLoading = false) }
            return TradeSetupConfigResult.ValidationFailed(mapOf("balance" to "Insufficient balance"))
        }

        if (tradeAmount > bal) {
            val err = "Trade amount exceeds available balance (${String.format(Locale.US, "%.2f", bal)} $quoteAsset)."
            _uiState.update { it.copy(tradeAmountError = err, isLoading = false) }
            return TradeSetupConfigResult.ValidationFailed(mapOf("tradeAmount" to err))
        }

        val riskParams = mutableMapOf<String, Double>()
        val tp = currentState.atrTakeProfitMultiplier ?: currentState.riskRewardRatio
        tp?.let {
            riskParams["atrTakeProfitMultiplier"] = it
            riskParams["riskRewardRatio"] = it // Legacy mirror for backward compatibility
        }
        currentState.atrStopLossMultiplier?.let { riskParams["atrStopLossMultiplier"] = it }

        val config = TradeSetupConfig(
            strategyId = strategyId,
            symbol = candidate?.symbol,
            entryPrice = 0.0, // Dynamic Market Entry: no fixed coin entry price!
            tradeValueUsdt = tradeAmount,
            parameters = emptyMap(),
            riskParameters = riskParams,
            entryIntent = currentState.selectedEntryIntent
        )
        sessionRepository.setTradeSetupConfig(config)
        _uiState.update { it.copy(isLoading = false) }

        try {
            com.cryptopulse.app.forensics.CidDiagnosticManager.logBot(
                symbol = candidate?.symbol,
                strategyId = strategyId,
                riskClassification = "TRADE_SETUP_CONFIRMED: tradeValueUsdt=$tradeAmount, TP_ATR=${currentState.atrTakeProfitMultiplier}, SL_ATR=${currentState.atrStopLossMultiplier}"
            )
        } catch (_: Throwable) {}

        return TradeSetupConfigResult.Success(config)
    }
}






