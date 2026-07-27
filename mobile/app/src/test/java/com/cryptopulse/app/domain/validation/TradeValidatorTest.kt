package com.cryptopulse.app.domain.validation

import com.cryptopulse.app.domain.models.SymbolTradingRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TradeValidatorTest {

    private val mockBtcRules = SymbolTradingRules(
        schemaVersion = "2.0",
        symbol = "BTCUSDT",
        exchange = "binance",
        baseAsset = "BTC",
        quoteAsset = "USDT",
        minNotional = 10.0,
        minQty = 0.00001,
        maxQty = 1000.0,
        stepSize = 0.00001,
        tickSize = 0.1,
        minPrice = 0.1,
        maxPrice = 1000000.0,
        contractSize = 1.0,
        lastUpdated = System.currentTimeMillis()
    )

    @Test
    fun `validate returns false when rules are null`() {
        val result = TradeValidator.validate(
            params = TradeValidationParams(symbol = "BTCUSDT", entryPrice = 50000.0),
            rules = null
        )
        assertFalse(result.isValid)
        assertEquals(ValidationErrorReason.EXCHANGE_METADATA_UNAVAILABLE, result.errorCode)
    }

    @Test
    fun `validate rejects trade below minimum notional requirement`() {
        val result = TradeValidator.validate(
            params = TradeValidationParams(symbol = "BTCUSDT", entryPrice = 50000.0, tradeValueUsdt = 5.0),
            rules = mockBtcRules
        )
        assertFalse(result.isValid)
        assertEquals(ValidationErrorReason.MIN_NOTIONAL_FAILED, result.errorCode)
    }

    @Test
    fun `validate accepts trade meeting minimum notional requirement`() {
        val result = TradeValidator.validate(
            params = TradeValidationParams(symbol = "BTCUSDT", entryPrice = 50000.0, tradeValueUsdt = 20.0),
            rules = mockBtcRules
        )
        assertTrue(result.isValid)
        assertEquals(20.0, result.postRoundingNotional!!, 0.01)
    }

    @Test
    fun `validate quantizes quantity to step size`() {
        val result = TradeValidator.validate(
            params = TradeValidationParams(symbol = "BTCUSDT", entryPrice = 50000.0, quantity = 0.000329),
            rules = mockBtcRules
        )
        assertTrue(result.isValid)
        assertEquals(0.00032, result.quantizedQuantity!!, 0.000001)
    }
}
