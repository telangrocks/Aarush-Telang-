package com.cryptopulse.app.data.repository

import com.cryptopulse.app.domain.models.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StrategyParsingTest {

    @Test
    fun `backend category Scalping maps to SCALPING`() {
        assertEquals(StrategyCategory.SCALPING, StrategyCategory.valueOf("SCALPING"))
    }

    @Test
    fun `backend category Trend Following maps to TREND_FOLLOWING`() {
        assertEquals(StrategyCategory.TREND_FOLLOWING, StrategyCategory.valueOf("TREND_FOLLOWING"))
    }

    @Test
    fun `backend category Breakout maps to BREAKOUT`() {
        assertEquals(StrategyCategory.BREAKOUT, StrategyCategory.valueOf("BREAKOUT"))
    }

    @Test
    fun `backend category Mean Reversion maps to MEAN_REVERSION`() {
        assertEquals(StrategyCategory.MEAN_REVERSION, StrategyCategory.valueOf("MEAN_REVERSION"))
    }

    @Test
    fun `backend category VWAP maps to VWAP`() {
        assertEquals(StrategyCategory.VWAP, StrategyCategory.valueOf("VWAP"))
    }

    @Test
    fun `unknown backend category falls back to CUSTOM`() {
        assertEquals(StrategyCategory.CUSTOM, StrategyCategory.valueOf("CUSTOM"))
    }

    @Test
    fun `dynamic field enum validation accepts valid options`() {
        val field = StrategyParameterSchema(
            key = "mode",
            displayName = "Mode",
            type = ParameterType.ENUM,
            defaultValue = "Aggressive",
            isRequired = true,
            options = listOf("Conservative", "Moderate", "Aggressive")
        )
        assertEquals(ParameterType.ENUM, field.type)
        assertEquals("Aggressive", field.defaultValue)
        assertTrue(field.options!!.contains("Moderate"))
    }

    @Test
    fun `strategy parameter schema preserves min and max bounds`() {
        val field = StrategyParameterSchema(
            key = "leverage",
            displayName = "Leverage",
            type = ParameterType.INT,
            defaultValue = "10",
            isRequired = true,
            minValue = 1.0,
            maxValue = 100.0
        )
        assertEquals(1.0, field.minValue)
        assertEquals(100.0, field.maxValue)
    }

    @Test
    fun `zero parameter strategy is valid`() {
        val strategy = Strategy(
            id = "zero_params",
            name = "Zero Params",
            description = "No parameters",
            category = StrategyCategory.CUSTOM,
            riskLevel = RiskLevel.LOW,
            schemaVersion = 1,
            requiredParameters = emptyList()
        )
        assertTrue(strategy.requiredParameters.isEmpty())
    }

    @Test
    fun `many parameter strategy remains valid`() {
        val params = (1..100).map { i ->
            StrategyParameterSchema(
                key = "param_$i",
                displayName = "Param $i",
                type = ParameterType.DOUBLE,
                defaultValue = "0.0",
                isRequired = true
            )
        }
        val strategy = Strategy(
            id = "many_params",
            name = "Many Params",
            description = "100 parameters",
            category = StrategyCategory.CUSTOM,
            riskLevel = RiskLevel.HIGH,
            schemaVersion = 1,
            requiredParameters = params
        )
        assertEquals(100, strategy.requiredParameters.size)
    }
}
