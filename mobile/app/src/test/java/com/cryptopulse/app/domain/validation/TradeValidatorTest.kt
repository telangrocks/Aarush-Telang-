package com.cryptopulse.app.domain.validation

import com.cryptopulse.app.domain.models.SymbolTradingRules
import org.junit.Assert.*
import org.junit.Test

class TradeValidatorTest {

    private val baseRules = SymbolTradingRules(
        symbol = "BTCUSDT",
        exchange = "Binance",
        baseAsset = "BTC",
        quoteAsset = "USDT",
        minPrice = 10000.0,
        maxPrice = 100000.0,
        tickSize = 0.01,
        minQty = 0.0001,
        maxQty = 100.0,
        stepSize = 0.0001,
        minNotional = 10.0
    )

    @Test
    fun `valid price should pass`() {
        val params = TradeValidationParams(symbol = "BTCUSDT", entryPriceStr = "50000.00", currentMarketPrice = 50000.0)
        val result = TradeValidator.validate(params, baseRules)
        assertTrue(result.errorMessage, result.isValid)
    }

    @Test
    fun `price violating tick size should fail`() {
        // Tick size is 0.01, so 50000.005 should fail
        val params = TradeValidationParams(symbol = "BTCUSDT", entryPriceStr = "50000.005", currentMarketPrice = 50000.0)
        val result = TradeValidator.validate(params, baseRules)
        assertFalse("Price with too many decimals should fail", result.isValid)
        assertEquals(ValidationErrorReason.INVALID_TICK_SIZE, result.errorCode)
    }

    @Test
    fun `price below minimum should fail`() {
        val params = TradeValidationParams(symbol = "BTCUSDT", entryPriceStr = "5000.0", currentMarketPrice = 5000.0)
        val result = TradeValidator.validate(params, baseRules)
        assertFalse("Price below minPrice should fail", result.isValid)
        assertEquals(ValidationErrorReason.PRICE_BELOW_MINIMUM, result.errorCode)
    }

    @Test
    fun `price above maximum should fail`() {
        val params = TradeValidationParams(symbol = "BTCUSDT", entryPriceStr = "150000.0", currentMarketPrice = 150000.0)
        val result = TradeValidator.validate(params, baseRules)
        assertFalse("Price above maxPrice should fail", result.isValid)
        assertEquals(ValidationErrorReason.PRICE_ABOVE_MAXIMUM, result.errorCode)
    }

    @Test
    fun `missing rules should fail with clear error`() {
        val params = TradeValidationParams(symbol = "BTCUSDT", entryPriceStr = "50000.0", currentMarketPrice = 50000.0)
        val result = TradeValidator.validate(params, null)
        assertFalse(result.isValid)
        assertEquals(ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE, result.errorCode)
    }

    @Test
    fun `very small tick size handling`() {
        val rules = baseRules.copy(tickSize = 0.00000001, minPrice = 0.0, maxPrice = 1.0)
        val params = TradeValidationParams(symbol = "SHIBUSDT", entryPriceStr = "0.00001234", currentMarketPrice = 0.00001234)
        val result = TradeValidator.validate(params, rules)
        assertTrue(result.isValid)
        
        val invalidParams = TradeValidationParams(symbol = "SHIBUSDT", entryPriceStr = "0.000012345", currentMarketPrice = 0.00001234)
        val invalidResult = TradeValidator.validate(invalidParams, rules)
        assertFalse("Price violating 8-decimal tick size should fail", invalidResult.isValid)
    }
    
    @Test
    fun `fat-finger protection should fail when variance exceeds 15 percent`() {
        // Current market price is 50000, 15% variance allows [42500, 57500]
        val paramsBelow = TradeValidationParams(symbol = "BTCUSDT", entryPriceStr = "40000.0", currentMarketPrice = 50000.0)
        val resultBelow = TradeValidator.validate(paramsBelow, baseRules)
        assertFalse("Price too far below market should fail", resultBelow.isValid)
        assertEquals(ValidationErrorReason.PRICE_VARIANCE_EXCEEDED, resultBelow.errorCode)
        assertTrue(resultBelow.errorMessage?.contains("50,000.00") == true)
        
        val paramsAbove = TradeValidationParams(symbol = "BTCUSDT", entryPriceStr = "60000.0", currentMarketPrice = 50000.0)
        val resultAbove = TradeValidator.validate(paramsAbove, baseRules)
        assertFalse("Price too far above market should fail", resultAbove.isValid)
        assertEquals(ValidationErrorReason.PRICE_VARIANCE_EXCEEDED, resultAbove.errorCode)
        assertTrue(resultAbove.errorMessage?.contains("50,000.00") == true)
    }
}
