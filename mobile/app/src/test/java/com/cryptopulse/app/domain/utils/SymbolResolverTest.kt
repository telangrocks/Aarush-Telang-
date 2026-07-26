package com.cryptopulse.app.domain.utils

import org.junit.Assert.assertEquals
import org.junit.Test

class SymbolResolverTest {

    @Test
    fun `resolve normalizes lowercase base asset btc`() {
        val res = SymbolResolver.resolve("btc")
        assertEquals("BTCUSDT", res.symbol)
        assertEquals("BTC", res.baseAsset)
        assertEquals("USDT", res.quoteAsset)
    }

    @Test
    fun `resolve handles slash format BTC-USDT`() {
        val res = SymbolResolver.resolve("BTC/USDT")
        assertEquals("BTCUSDT", res.symbol)
        assertEquals("BTC", res.baseAsset)
        assertEquals("USDT", res.quoteAsset)
    }

    @Test
    fun `resolve handles hyphen format SOL-USDT`() {
        val res = SymbolResolver.resolve("SOL-USDT")
        assertEquals("SOLUSDT", res.symbol)
        assertEquals("SOL", res.baseAsset)
        assertEquals("USDT", res.quoteAsset)
    }

    @Test
    fun `toCacheKey returns normalized symbol key`() {
        val key = SymbolResolver.toCacheKey("ethusdt")
        assertEquals("ETHUSDT", key)
    }
}
