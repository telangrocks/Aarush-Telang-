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

}
