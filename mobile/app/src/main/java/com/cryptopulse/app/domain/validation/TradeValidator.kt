package com.cryptopulse.app.domain.validation

import com.cryptopulse.app.domain.models.SymbolTradingRules
import java.math.BigDecimal
import java.math.RoundingMode

data class TradeValidationParams(
    val symbol: String,
    val entryPriceStr: String,
    val currentMarketPrice: Double,
    val tradeValueUsdt: Double? = null,
    val quantity: Double? = null,
    val stopLoss: Double? = null,
    val takeProfit: Double? = null
)

data class TradeValidationResult(
    val isValid: Boolean,
    val errorCode: ValidationErrorReason? = null,
    val errorMessage: String? = null,
    val quantizedQuantity: Double? = null,
    val postRoundingNotional: Double? = null
)

object TradeValidator {

    /**
     * Evaluates trade parameters against verified exchange symbol trading rules using
     * high-precision arbitrary decimal arithmetic (java.math.BigDecimal).
     */
    fun validate(
        params: TradeValidationParams,
        rules: SymbolTradingRules?
    ): TradeValidationResult {
        // 1. Metadata Check
        if (rules == null || rules.symbol.isBlank()) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE,
                errorMessage = "Exchange trading rules for '${params.symbol}' could not be loaded from exchange. Please try again."
            )
        }

        // 2. Input Parameter Validation
        val entryPriceBD = try {
            BigDecimal(params.entryPriceStr)
        } catch (e: NumberFormatException) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.INVALID_INPUT_PARAMETERS,
                errorMessage = "Entry price must be a valid number."
            )
        }

        val entryPrice = entryPriceBD.toDouble()
        if (entryPrice <= 0.0 || entryPrice.isNaN() || entryPrice.isInfinite()) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.INVALID_INPUT_PARAMETERS,
                errorMessage = "Entry price must be a valid positive number."
            )
        }

        // Fat-Finger protection
        val marketPrice = params.currentMarketPrice
        if (marketPrice > 0.0) {
            val variance = Math.abs((entryPrice - marketPrice) / marketPrice)
            if (variance > 0.15) {
                val formattedMarketPrice = java.text.NumberFormat.getCurrencyInstance(java.util.Locale.US).format(marketPrice)
                return TradeValidationResult(
                    isValid = false,
                    errorCode = ValidationErrorReason.PRICE_VARIANCE_EXCEEDED,
                    errorMessage = "Price deviates too far from market price of $formattedMarketPrice"
                )
            }
        }

        val isEntryPriceOnly = params.quantity == null && params.tradeValueUsdt == null

        if (rules.minPrice == null || rules.tickSize == null) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE,
                errorMessage = "Trading rules for this pair are currently unavailable from the exchange."
            )
        }

        if (!isEntryPriceOnly) {
            if (rules.stepSize == null || rules.minQty == null || rules.minNotional == null) {
                return TradeValidationResult(
                    isValid = false,
                    errorCode = ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE,
                    errorMessage = "Trading rules for this pair are currently unavailable from the exchange."
                )
            }
        }

        // 3. Price & Tick Size Filter
        val minPriceBD = rules.minPrice?.let { BigDecimal.valueOf(it) } ?: BigDecimal.ZERO
        val maxPriceBD = rules.maxPrice?.let { BigDecimal.valueOf(it) } ?: BigDecimal.ZERO
        val tickSizeBD = rules.tickSize?.let { BigDecimal.valueOf(it) } ?: BigDecimal.ZERO

        if (minPriceBD > BigDecimal.ZERO && entryPriceBD < minPriceBD) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.PRICE_BELOW_MINIMUM,
                errorMessage = "Please enter a valid entry price for this trading pair."
            )
        }

        if (maxPriceBD > BigDecimal.ZERO && entryPriceBD > maxPriceBD) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.PRICE_ABOVE_MAXIMUM,
                errorMessage = "Please enter a valid entry price for this trading pair."
            )
        }

        if (tickSizeBD > BigDecimal.ZERO) {
            val remainder = entryPriceBD.remainder(tickSizeBD)
            if (remainder.compareTo(BigDecimal.ZERO) != 0) {
                return TradeValidationResult(
                    isValid = false,
                    errorCode = ValidationErrorReason.INVALID_TICK_SIZE,
                    errorMessage = "Please enter a valid entry price for this trading pair."
                )
            }
        }

        return TradeValidationResult(isValid = true)
    }
}
