package com.cryptopulse.app.domain.validation

import com.cryptopulse.app.domain.models.SymbolTradingRules
import java.math.BigDecimal
import java.math.RoundingMode

data class TradeValidationParams(
    val symbol: String,
    val entryPrice: Double,
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
        if (params.entryPrice <= 0.0 || params.entryPrice.isNaN() || params.entryPrice.isInfinite()) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.INVALID_INPUT_PARAMETERS,
                errorMessage = "Entry price must be a valid positive number."
            )
        }
        val entryPriceBD = BigDecimal.valueOf(params.entryPrice)

        // Null constraints check
        if (rules.minPrice == null || rules.maxPrice == null || rules.tickSize == null || 
            rules.stepSize == null || rules.minQty == null || rules.maxQty == null || rules.minNotional == null) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE,
                errorMessage = "Trading rules for this pair are currently unavailable from the exchange."
            )
        }

        // 3. Price & Tick Size Filter
        val minPriceBD = BigDecimal.valueOf(rules.minPrice)
        val maxPriceBD = BigDecimal.valueOf(rules.maxPrice)
        val tickSizeBD = BigDecimal.valueOf(rules.tickSize)

        if (minPriceBD > BigDecimal.ZERO && entryPriceBD < minPriceBD) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.PRICE_BELOW_MINIMUM,
                errorMessage = "Entry price ($${entryPriceBD.toPlainString()}) is below exchange minimum price ($${minPriceBD.toPlainString()})."
            )
        }

        if (maxPriceBD > BigDecimal.ZERO && entryPriceBD > maxPriceBD) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.PRICE_ABOVE_MAXIMUM,
                errorMessage = "Entry price ($${entryPriceBD.toPlainString()}) exceeds exchange maximum price ($${maxPriceBD.toPlainString()})."
            )
        }

        if (tickSizeBD > BigDecimal.ZERO) {
            val remainder = entryPriceBD.remainder(tickSizeBD)
            if (remainder.compareTo(BigDecimal.ZERO) != 0) {
                val threshold = tickSizeBD.multiply(BigDecimal.valueOf(0.0001))
                if (remainder > threshold && (tickSizeBD - remainder) > threshold) {
                    return TradeValidationResult(
                        isValid = false,
                        errorCode = ValidationErrorReason.INVALID_TICK_SIZE,
                        errorMessage = "Entry price ($${entryPriceBD.toPlainString()}) does not align with exchange tick size (${tickSizeBD.toPlainString()})."
                    )
                }
            }
        }

        // 4. Raw Quantity Calculation
        val rawQtyBD: BigDecimal = when {
            params.quantity != null && params.quantity > 0.0 -> {
                BigDecimal.valueOf(params.quantity)
            }
            params.tradeValueUsdt != null && params.tradeValueUsdt > 0.0 -> {
                BigDecimal.valueOf(params.tradeValueUsdt).divide(entryPriceBD, 12, RoundingMode.HALF_UP)
            }
            else -> {
                return TradeValidationResult(
                    isValid = false,
                    errorCode = ValidationErrorReason.INVALID_INPUT_PARAMETERS,
                    errorMessage = "Trade quantity or trade amount (USDT) must be provided."
                )
            }
        }

        // 5. Step Size Quantization (Floor rounding to stepSize)
        val stepSizeBD = BigDecimal.valueOf(rules.stepSize)
        val roundedQtyBD: BigDecimal = if (stepSizeBD > BigDecimal.ZERO) {
            val steps = rawQtyBD.divide(stepSizeBD, 0, RoundingMode.FLOOR)
            steps.multiply(stepSizeBD)
        } else {
            rawQtyBD
        }

        // 6. Quantity Filter (Min/Max Qty)
        val minQtyBD = BigDecimal.valueOf(rules.minQty)
        val maxQtyBD = BigDecimal.valueOf(rules.maxQty)

        if (roundedQtyBD < minQtyBD) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.MIN_QTY_FAILED,
                errorMessage = "Order quantity (${roundedQtyBD.toPlainString()}) is below exchange minimum order quantity (${minQtyBD.toPlainString()}).",
                quantizedQuantity = roundedQtyBD.toDouble()
            )
        }

        if (maxQtyBD > BigDecimal.ZERO && roundedQtyBD > maxQtyBD) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.MAX_QTY_FAILED,
                errorMessage = "Order quantity (${roundedQtyBD.toPlainString()}) exceeds exchange maximum order quantity (${maxQtyBD.toPlainString()}).",
                quantizedQuantity = roundedQtyBD.toDouble()
            )
        }

        // 7. Post-Rounding Notional Calculation
        val postRoundingNotionalBD = roundedQtyBD.multiply(entryPriceBD)
        val minNotionalBD = BigDecimal.valueOf(rules.minNotional)

        if (minNotionalBD > BigDecimal.ZERO && postRoundingNotionalBD < minNotionalBD) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.MIN_NOTIONAL_FAILED,
                errorMessage = "Order value ($${"%.2f".format(postRoundingNotionalBD.toDouble())} USDT) is below exchange minimum notional requirement of $${"%.2f".format(minNotionalBD.toDouble())} USDT.",
                quantizedQuantity = roundedQtyBD.toDouble(),
                postRoundingNotional = postRoundingNotionalBD.toDouble()
            )
        }

        // 8. Order Limits
        if (rules.maxPosition != null && postRoundingNotionalBD > BigDecimal.valueOf(rules.maxPosition)) {
            return TradeValidationResult(
                isValid = false,
                errorCode = ValidationErrorReason.MAX_POSITION_FAILED,
                errorMessage = "Order value ($${"%.2f".format(postRoundingNotionalBD.toDouble())} USDT) exceeds exchange order limit ($${rules.maxPosition} USDT).",
                quantizedQuantity = roundedQtyBD.toDouble(),
                postRoundingNotional = postRoundingNotionalBD.toDouble()
            )
        }

        return TradeValidationResult(
            isValid = true,
            quantizedQuantity = roundedQtyBD.toDouble(),
            postRoundingNotional = postRoundingNotionalBD.toDouble()
        )
    }
}
