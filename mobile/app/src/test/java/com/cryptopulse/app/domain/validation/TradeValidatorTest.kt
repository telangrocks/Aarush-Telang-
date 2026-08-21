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
    fun `independent target entry price should pass when exchange bounds and tick size are valid`() {
        // Market price is 0.13, target entry price is 2.00
        val rules = baseRules.copy(minPrice = 0.01, maxPrice = 1000.0, tickSize = 0.01)
        val params = TradeValidationParams(symbol = "DOGEUSDT", entryPriceStr = "2.00", currentMarketPrice = 0.13)
        val result = TradeValidator.validate(params, rules)
        assertTrue("Independent target price (2.00 on 0.13 market) within bounds should pass", result.isValid)
    }
}
