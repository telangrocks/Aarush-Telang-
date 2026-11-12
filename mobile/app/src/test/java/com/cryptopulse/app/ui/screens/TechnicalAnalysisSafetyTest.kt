package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.domain.models.ConditionSummary
import com.cryptopulse.app.domain.models.IndicatorSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class TechnicalAnalysisSafetyTest {

    private fun calculateClampedProgress(score: Int): Float {
        return (score / 100f).coerceIn(0f, 1f)
    }

    private fun generateIndicatorKey(index: Int, indicator: IndicatorSummary): String {
        return "${indicator.name}_$index"
    }

    private fun generateCheckpointKey(index: Int, checkpoint: ConditionSummary): String {
        return "${checkpoint.id.ifBlank { checkpoint.name }}_$index"
    }

    @Test
    fun `clamped progress should safely constrain negative scores to 0`() {
        val progress = calculateClampedProgress(-25)
        assertEquals(0f, progress, 0.0001f)
    }

    @Test
    fun `clamped progress should produce exact 0 for zero score`() {
        val progress = calculateClampedProgress(0)
        assertEquals(0f, progress, 0.0001f)
    }

    @Test
    fun `clamped progress should produce exact fractional value for normal score`() {
        val progress = calculateClampedProgress(75)
        assertEquals(0.75f, progress, 0.0001f)
    }

    @Test
    fun `clamped progress should produce exact 1 for 100 score`() {
        val progress = calculateClampedProgress(100)
        assertEquals(1.0f, progress, 0.0001f)
    }

    @Test
    fun `clamped progress should safely constrain overflow scores to 1`() {
        val progress = calculateClampedProgress(125)
        assertEquals(1.0f, progress, 0.0001f)
    }

    @Test
    fun `duplicate indicator names should produce guaranteed unique composite keys`() {
        val indicators = listOf(
            IndicatorSummary(name = "RSI", value = "65.0", signal = "BULLISH"),
            IndicatorSummary(name = "RSI", value = "70.0", signal = "BULLISH"),
            IndicatorSummary(name = "RSI", value = "55.0", signal = "NEUTRAL")
        )

        val keys = indicators.mapIndexed { index, indicator -> generateIndicatorKey(index, indicator) }

        assertEquals(3, keys.toSet().size)
        assertEquals("RSI_0", keys[0])
        assertEquals("RSI_1", keys[1])
        assertEquals("RSI_2", keys[2])
    }

    @Test
    fun `blank indicator names should produce guaranteed unique composite keys`() {
        val indicators = listOf(
            IndicatorSummary(name = "", value = "10.0", signal = "NEUTRAL"),
            IndicatorSummary(name = "", value = "20.0", signal = "NEUTRAL")
        )

        val keys = indicators.mapIndexed { index, indicator -> generateIndicatorKey(index, indicator) }

        assertEquals(2, keys.toSet().size)
        assertEquals("_0", keys[0])
        assertEquals("_1", keys[1])
    }

    @Test
    fun `duplicate checkpoint IDs should produce guaranteed unique composite keys`() {
        val checkpoints = listOf(
            ConditionSummary(id = "trend", name = "Trend 15m", currentValue = "OK", targetValue = "OK", status = "PASSED"),
            ConditionSummary(id = "trend", name = "Trend 1h", currentValue = "OK", targetValue = "OK", status = "PASSED")
        )

        val keys = checkpoints.mapIndexed { index, checkpoint -> generateCheckpointKey(index, checkpoint) }

        assertEquals(2, keys.toSet().size)
        assertEquals("trend_0", keys[0])
        assertEquals("trend_1", keys[1])
    }

    @Test
    fun `blank checkpoint IDs with duplicate names should produce guaranteed unique composite keys`() {
        val checkpoints = listOf(
            ConditionSummary(id = "", name = "EMA Confirmation", currentValue = "PASS", targetValue = "PASS", status = "PASSED"),
            ConditionSummary(id = "", name = "EMA Confirmation", currentValue = "PASS", targetValue = "PASS", status = "PASSED")
        )

        val keys = checkpoints.mapIndexed { index, checkpoint -> generateCheckpointKey(index, checkpoint) }

        assertEquals(2, keys.toSet().size)
        assertEquals("EMA Confirmation_0", keys[0])
        assertEquals("EMA Confirmation_1", keys[1])
    }

    @Test
    fun `BUDGET_INSUFFICIENT_AT_CURRENT_PRICE displays exact trade skipped message`() {
        val message = resolveStrategyScoreCardStatusText(
            qualificationStatus = "BLOCKED_BY_EXISTING_GATE",
            suppressionReason = "BUDGET_INSUFFICIENT_AT_CURRENT_PRICE",
            signalType = "BUY"
        )
        assertEquals("TRADE SKIPPED: Budget insufficient at current market price.", message)
    }

    @Test
    fun `INSUFFICIENT_BUDGET and BELOW_MIN_NOTIONAL also display exact trade skipped message`() {
        val msg1 = resolveStrategyScoreCardStatusText(
            qualificationStatus = "BLOCKED_BY_EXISTING_GATE",
            suppressionReason = "INSUFFICIENT_BUDGET",
            signalType = "BUY"
        )
        assertEquals("TRADE SKIPPED: Budget insufficient at current market price.", msg1)

        val msg2 = resolveStrategyScoreCardStatusText(
            qualificationStatus = "BLOCKED_BY_EXISTING_GATE",
            suppressionReason = "BELOW_MIN_NOTIONAL",
            signalType = "SELL"
        )
        assertEquals("TRADE SKIPPED: Budget insufficient at current market price.", msg2)
    }

    @Test
    fun `TICKER_UNAVAILABLE is kept distinct and does not falsely claim insufficient budget`() {
        val message = resolveStrategyScoreCardStatusText(
            qualificationStatus = "BLOCKED_BY_EXISTING_GATE",
            suppressionReason = "TICKER_UNAVAILABLE",
            signalType = "BUY"
        )
        assertEquals("ENTRY QUALIFICATION: BLOCKED (TICKER_UNAVAILABLE)", message)
        assertNotEquals("TRADE SKIPPED: Budget insufficient at current market price.", message)
    }

    @Test
    fun `qualified strategies display qualification status with signal type`() {
        val msgBuy = resolveStrategyScoreCardStatusText(
            qualificationStatus = "TRADE_QUALIFIED",
            suppressionReason = null,
            signalType = "BUY"
        )
        assertEquals("ENTRY QUALIFICATION: QUALIFIED (BUY)", msgBuy)

        val msgSell = resolveStrategyScoreCardStatusText(
            qualificationStatus = "TRADE_ALERT_CREATED",
            suppressionReason = null,
            signalType = "SELL"
        )
        assertEquals("ENTRY QUALIFICATION: QUALIFIED (SELL)", msgSell)
    }
}
