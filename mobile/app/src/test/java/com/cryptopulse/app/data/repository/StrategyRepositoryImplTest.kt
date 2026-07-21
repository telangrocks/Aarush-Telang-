package com.cryptopulse.app.data.repository

import com.cryptopulse.app.domain.models.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StrategyRepositoryImplTest {

    private val repository = StrategyRepositoryImpl()

    @Test
    fun `test getStrategies returns mock list`() = runBlocking {
        val result = repository.getStrategies()
        assertTrue(result.isSuccess)
        val list = result.getOrNull()
        assertTrue(list != null && list.isNotEmpty())
        assertEquals("scalping_v1", list?.get(0)?.id)
    }

    @Test
    fun `test getStrategyById returns correct strategy`() = runBlocking {
        val result = repository.getStrategyById("swing_v1")
        assertTrue(result.isSuccess)
        val strategy = result.getOrNull()
        assertEquals("swing_v1", strategy?.id)
        assertEquals("Swing Trading", strategy?.name)
    }

    @Test
    fun `test getStrategyById returns null for invalid ID`() = runBlocking {
        val result = repository.getStrategyById("invalid_id")
        assertTrue(result.isSuccess)
        assertNull(result.getOrNull())
    }

    @Test
    fun `test edge case zero parameters strategy`() {
        val strategy = Strategy(
            id = "zero_params",
            name = "Zero Params",
            description = "No parameters",
            category = StrategyCategory.GRID,
            riskLevel = RiskLevel.LOW,
            schemaVersion = 1,
            requiredParameters = emptyList()
        )
        assertTrue(strategy.requiredParameters.isEmpty())
    }

    @Test
    fun `test edge case many parameters strategy`() {
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
            category = StrategyCategory.ARBITRAGE,
            riskLevel = RiskLevel.HIGH,
            schemaVersion = 1,
            requiredParameters = params
        )
        assertEquals(100, strategy.requiredParameters.size)
    }
}
