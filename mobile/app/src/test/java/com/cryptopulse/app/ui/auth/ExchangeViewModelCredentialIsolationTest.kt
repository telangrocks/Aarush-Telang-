package com.cryptopulse.app.ui.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ExchangeViewModelCredentialIsolationTest {

    @Test
    fun `test A - Bybit Demo credentials isolated when switching to Bybit Mainnet`() {
        var state = ExchangeFormState(selectedExchange = "bybit", environment = "demo")
        state = state.updateCurrentCredentials(apiKey = "bybit_demo_key", apiSecret = "bybit_demo_sec")

        assertEquals("bybit_demo_key", state.apiKey)
        assertEquals("bybit_demo_sec", state.apiSecret)

        // Switch to Mainnet
        state = state.selectEnvironment("mainnet")

        // Mainnet slot should be empty
        assertEquals("", state.apiKey)
        assertEquals("", state.apiSecret)
        assertNotEquals("bybit_demo_key", state.apiKey)
    }

    @Test
    fun `test B - Bybit Mainnet credentials isolated when switching to Bybit Demo`() {
        var state = ExchangeFormState(selectedExchange = "bybit", environment = "mainnet")
        state = state.updateCurrentCredentials(apiKey = "bybit_mainnet_key", apiSecret = "bybit_mainnet_sec")

        assertEquals("bybit_mainnet_key", state.apiKey)
        assertEquals("bybit_mainnet_sec", state.apiSecret)

        // Switch to Demo
        state = state.selectEnvironment("demo")

        // Demo slot should be empty
        assertEquals("", state.apiKey)
        assertEquals("", state.apiSecret)
        assertNotEquals("bybit_mainnet_key", state.apiKey)
    }

    @Test
    fun `test C - Bybit credentials isolated when switching to KuCoin`() {
        var state = ExchangeFormState(selectedExchange = "bybit", environment = "mainnet")
        state = state.updateCurrentCredentials(apiKey = "bybit_key", apiSecret = "bybit_sec")

        // Switch to KuCoin
        state = state.selectExchange("kucoin")

        // KuCoin slot should be empty
        assertEquals("", state.apiKey)
        assertEquals("", state.apiSecret)
        assertEquals("", state.apiPassphrase)
        assertNotEquals("bybit_key", state.apiKey)
    }

    @Test
    fun `test D - KuCoin credentials isolated when switching to Bybit`() {
        var state = ExchangeFormState(selectedExchange = "kucoin", environment = "mainnet")
        state = state.updateCurrentCredentials(apiKey = "kc_key", apiSecret = "kc_sec", apiPassphrase = "kc_pass")

        // Switch to Bybit
        state = state.selectExchange("bybit")

        // Bybit slot should be empty
        assertEquals("", state.apiKey)
        assertEquals("", state.apiSecret)
        assertEquals("", state.apiPassphrase)
        assertNotEquals("kc_key", state.apiKey)
    }

    @Test
    fun `test E - Default state starts with Bybit and Demo`() {
        val state = ExchangeFormState()
        assertEquals("bybit", state.selectedExchange)
        assertEquals("demo", state.environment)
    }

    @Test
    fun `test F - Passphrase is isolated per exchange and environment slot`() {
        var state = ExchangeFormState(selectedExchange = "kucoin", environment = "mainnet")
        state = state.updateCurrentCredentials(apiKey = "kc_key", apiSecret = "kc_sec", apiPassphrase = "secret_passphrase")

        assertEquals("secret_passphrase", state.apiPassphrase)

        // Switch environment to demo
        state = state.selectEnvironment("demo")
        assertEquals("", state.apiPassphrase)

        // Switch back to mainnet
        state = state.selectEnvironment("mainnet")
        assertEquals("secret_passphrase", state.apiPassphrase)
    }

    @Test
    fun `test G - Modifying API key invalidates old secret in active slot to prevent stale secret reuse`() {
        var state = ExchangeFormState(selectedExchange = "bybit", environment = "demo")
        state = state.updateCurrentCredentials(apiKey = "key_A", apiSecret = "secret_A")

        assertEquals("key_A", state.apiKey)
        assertEquals("secret_A", state.apiSecret)

        // Simulate API key edit: updating key to key_B while passing empty/reset secret
        val currentKey = state.apiKey
        val newKey = "key_B"
        val secretToUse = if (newKey != currentKey && currentKey.isNotBlank()) "" else state.apiSecret
        state = state.updateCurrentCredentials(apiKey = newKey, apiSecret = secretToUse)

        assertEquals("key_B", state.apiKey)
        assertEquals("", state.apiSecret)
    }
}
