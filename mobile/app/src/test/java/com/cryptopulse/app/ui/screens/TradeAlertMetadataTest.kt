package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.data.api.dto.bot.response.BotAlertDto
import com.cryptopulse.app.data.mapper.bot.toDomain
import com.cryptopulse.app.domain.models.BotAlert
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TradeAlertMetadataTest {

    // ── 1. Strategy Name Normalization ──────────────────────────────────────────

    @Test
    fun testFormatStrategyName_canonicalStrategiesWithNewSuffix() {
        assertEquals("Scalper V2", formatStrategyName("ScalperV2_NEW"))
        assertEquals("Momentum", formatStrategyName("Momentum_NEW"))
        assertEquals("Breakout", formatStrategyName("Breakout_NEW"))
        assertEquals("Mean Reversion", formatStrategyName("MeanReversion_NEW"))
        assertEquals("VWAP", formatStrategyName("VWAP_NEW"))
    }

    @Test
    fun testFormatStrategyName_canonicalStrategiesWithoutSuffix() {
        assertEquals("Scalper V2", formatStrategyName("ScalperV2"))
        assertEquals("Momentum", formatStrategyName("Momentum"))
        assertEquals("Breakout", formatStrategyName("Breakout"))
        assertEquals("Mean Reversion", formatStrategyName("MeanReversion"))
        assertEquals("VWAP", formatStrategyName("VWAP"))
    }

    @Test
    fun testFormatStrategyName_customOrUnknownStrategy() {
        assertEquals("CustomAlpha", formatStrategyName("CustomAlpha_NEW"))
        assertEquals("TrendFollower", formatStrategyName("TrendFollower"))
    }

    @Test
    fun testFormatStrategyName_missingOrBlank_returnsFallbackDash() {
        assertEquals("—", formatStrategyName(null))
        assertEquals("—", formatStrategyName(""))
        assertEquals("—", formatStrategyName("   "))
    }

    // ── 2. Timeframe Normalization ──────────────────────────────────────────────

    @Test
    fun testFormatTimeframe_validTimeframes() {
        assertEquals("5m", formatTimeframe("5m"))
        assertEquals("15m", formatTimeframe("15m"))
        assertEquals("1h", formatTimeframe("1h"))
        assertEquals("4h", formatTimeframe("4h"))
        assertEquals("1d", formatTimeframe("1d"))
    }

    @Test
    fun testFormatTimeframe_caseInsensitive() {
        assertEquals("15m", formatTimeframe("15M"))
        assertEquals("1h", formatTimeframe("1H"))
        assertEquals("5m", formatTimeframe(" 5m "))
    }

    @Test
    fun testFormatTimeframe_missingOrBlank_returnsFallbackDash() {
        assertEquals("—", formatTimeframe(null))
        assertEquals("—", formatTimeframe(""))
        assertEquals("—", formatTimeframe("   "))
    }

    // ── 3. BotAlert Model and Mapper Parity ─────────────────────────────────────

    @Test
    fun testBotAlert_toMapAndFromMapWithTimeframe() {
        val alert = BotAlert(
            id = "alert_test_1",
            symbol = "BTC/USDT",
            entryPrice = 95000.0,
            stopLoss = 93500.0,
            takeProfit = 98000.0,
            estimatedPnl = 300.0,
            strategy = "Momentum_NEW",
            side = "BUY",
            timestamp = "2026-10-08T12:00:00Z",
            timeframe = "15m"
        )

        val map = alert.toMap()
        assertEquals("15m", map["timeframe"])
        assertEquals("Momentum_NEW", map["strategy"])

        val reconstructed = BotAlert.fromMap(map)
        assertEquals("15m", reconstructed.timeframe)
        assertEquals("Momentum_NEW", reconstructed.strategy)
    }

    @Test
    fun testBotAlert_toMapAndFromMapWithoutTimeframe_backwardCompatibility() {
        val alert = BotAlert(
            id = "alert_legacy",
            symbol = "ETH/USDT",
            entryPrice = 3500.0,
            stopLoss = 3400.0,
            takeProfit = 3700.0,
            estimatedPnl = 150.0,
            strategy = null,
            side = "SELL",
            timestamp = "2026-10-08T12:00:00Z",
            timeframe = null
        )

        val map = alert.toMap()
        assertNull(map["timeframe"])
        assertNull(map["strategy"])

        val reconstructed = BotAlert.fromMap(map)
        assertNull(reconstructed.timeframe)
        assertNull(reconstructed.strategy)
        assertEquals("—", formatStrategyName(reconstructed.strategy))
        assertEquals("—", formatTimeframe(reconstructed.timeframe))
    }

    @Test
    fun testBotAlertDto_toDomainMapsTimeframe() {
        val dto = BotAlertDto(
            id = "alert_dto_1",
            symbol = "SOL/USDT",
            entryPrice = 220.0,
            stopLoss = 210.0,
            takeProfit = 240.0,
            estimatedPnl = 50.0,
            strategy = "ScalperV2_NEW",
            side = "SELL",
            timestamp = "2026-10-08T12:00:00Z",
            signalPrice = 220.0,
            targetEntryPrice = 220.0,
            timeframe = "5m"
        )

        val domain = dto.toDomain()
        assertEquals("5m", domain.timeframe)
        assertEquals("ScalperV2_NEW", domain.strategy)
        assertEquals("Scalper V2", formatStrategyName(domain.strategy))
        assertEquals("5m", formatTimeframe(domain.timeframe))
    }

    // ── 4. BUY and SELL alerts preserving strategy and timeframe ────────────────

    @Test
    fun testBuyAlert_momentum15m() {
        val buyMap = mapOf<String, Any>(
            "id" to "alert_buy",
            "symbol" to "BTC/USDT",
            "side" to "BUY",
            "strategy" to "Momentum_NEW",
            "timeframe" to "15m"
        )
        val stratDisplay = formatStrategyName(buyMap["strategy"] as? String)
        val tfDisplay = formatTimeframe(buyMap["timeframe"] as? String)
        assertEquals("Momentum", stratDisplay)
        assertEquals("15m", tfDisplay)
    }

    @Test
    fun testSellAlert_breakout1h() {
        val sellMap = mapOf<String, Any>(
            "id" to "alert_sell",
            "symbol" to "ETH/USDT",
            "side" to "SELL",
            "strategy" to "Breakout_NEW",
            "timeframe" to "1h"
        )
        val stratDisplay = formatStrategyName(sellMap["strategy"] as? String)
        val tfDisplay = formatTimeframe(sellMap["timeframe"] as? String)
        assertEquals("Breakout", stratDisplay)
        assertEquals("1h", tfDisplay)
    }
}
