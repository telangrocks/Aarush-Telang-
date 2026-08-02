package com.cryptopulse.app.ui.utils

import org.junit.Assert.assertEquals
import org.junit.Test

class FormattersTest {

    @Test
    fun `formatCryptoPrice formats various price ranges correctly`() {
        assertEquals("0.1863", Formatters.formatCryptoPrice(0.1863))
        assertEquals("1245.50", Formatters.formatCryptoPrice(1245.5))
        assertEquals("--", Formatters.formatCryptoPrice(0.0))
        assertEquals("--", Formatters.formatCryptoPrice(-1.5))
        assertEquals("--", Formatters.formatCryptoPrice(Double.NaN))
    }

    @Test
    fun `formatQuoteVolume formats millions and thousands correctly`() {
        assertEquals("$4.77M", Formatters.formatQuoteVolume(4769496.04))
        assertEquals("$450.5K", Formatters.formatQuoteVolume(450500.0))
        assertEquals("$0.0M", Formatters.formatQuoteVolume(0.0))
        assertEquals("$0.0M", Formatters.formatQuoteVolume(-50.0))
    }

    @Test
    fun `formatPercentage handles positive and negative percentages`() {
        assertEquals("+8.38%", Formatters.formatPercentage(8.377))
        assertEquals("-2.16%", Formatters.formatPercentage(-2.155))
        assertEquals("+0.00%", Formatters.formatPercentage(-0.0))
        assertEquals("+0.00%", Formatters.formatPercentage(Double.NaN))
    }

    @Test
    fun `formatScore formats to single decimal`() {
        assertEquals("133.8", Formatters.formatScore(133.77))
        assertEquals("0.0", Formatters.formatScore(0.0))
    }

    @Test
    fun `formatMinNotional formats USD currency`() {
        assertEquals("$5.00", Formatters.formatMinNotional(5.0))
        assertEquals("$0.00", Formatters.formatMinNotional(0.0))
    }
}
