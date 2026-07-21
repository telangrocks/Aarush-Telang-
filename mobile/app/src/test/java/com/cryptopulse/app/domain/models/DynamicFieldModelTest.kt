package com.cryptopulse.app.domain.models

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DynamicFieldModelTest {

    @Test
    fun `test complete schema mapping to dynamic field`() {
        val schema = StrategyParameterSchema(
            key = "leverage",
            displayName = "Leverage",
            type = ParameterType.INT,
            defaultValue = "10",
            isRequired = true,
            minValue = 1.0,
            maxValue = 50.0,
            options = null
        )
        val field = schema.toDynamicFieldModel()
        assertEquals("leverage", field.key)
        assertEquals(ParameterType.INT, field.type)
        assertEquals("10", field.defaultValue)
        assertEquals(true, field.isRequired)
        assertEquals(1.0, field.minValue)
        assertEquals(50.0, field.maxValue)
        assertNull(field.options)
    }

    @Test
    fun `test enum schema mapping to dynamic field`() {
        val schema = StrategyParameterSchema(
            key = "target_count",
            displayName = "Targets",
            type = ParameterType.ENUM,
            defaultValue = "1",
            isRequired = false,
            minValue = null,
            maxValue = null,
            options = listOf("1", "2", "3")
        )
        val field = schema.toDynamicFieldModel()
        assertEquals("target_count", field.key)
        assertEquals(ParameterType.ENUM, field.type)
        assertEquals("1", field.defaultValue)
        assertEquals(false, field.isRequired)
        assertNull(field.minValue)
        assertEquals(listOf("1", "2", "3"), field.options)
    }

    @Test
    fun `test edge case mapping with null bounds`() {
        val schema = StrategyParameterSchema(
            key = "use_trailing_sl",
            displayName = "Trailing SL",
            type = ParameterType.BOOLEAN,
            defaultValue = "false",
            isRequired = true
        )
        val field = schema.toDynamicFieldModel()
        assertEquals(ParameterType.BOOLEAN, field.type)
        assertEquals("false", field.defaultValue)
        assertNull(field.minValue)
        assertNull(field.maxValue)
        assertNull(field.options)
    }
}
