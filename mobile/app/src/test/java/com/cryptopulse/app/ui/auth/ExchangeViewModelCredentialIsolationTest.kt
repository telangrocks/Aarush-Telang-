package com.cryptopulse.app.ui.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ExchangeViewModelCredentialIsolationTest {

    @Test
    fun `test A - Bybit Testnet credentials isolated when switching to Bybit Mainnet`() {
        var state = ExchangeFormState(selectedExchange = "bybit", environment = "testnet")
        state = state.updateCurrentCredentials(apiKey = "bybit_testnet_key", apiSecret = "bybit_testnet_sec")

        assertEquals("bybit_testnet_key", state.apiKey)
        assertEquals("bybit_testnet_sec", state.apiSecret)

        // Switch to Mainnet
        state = state.selectEnvironment("mainnet")

        // Mainnet slot should be empty
        assertEquals("", state.apiKey)
        assertEquals("", state.apiSecret)
        assertNotEquals("bybit_testnet_key", state.apiKey)
    }

    @Test
    fun `test B - Bybit Mainnet credentials isolated when switching to Bybit Testnet`() {
        var state = ExchangeFormState(selectedExchange = "bybit", environment = "mainnet")
        state = state.updateCurrentCredentials(apiKey = "bybit_mainnet_key", apiSecret = "bybit_mainnet_sec")

        assertEquals("bybit_mainnet_key", state.apiKey)
        assertEquals("bybit_mainnet_sec", state.apiSecret)

        // Switch to Testnet
        state = state.selectEnvironment("testnet")

        // Testnet slot should be empty
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
    fun `test E - Binance Testnet credentials preserved when switching away and back`() {
        var state = ExchangeFormState(selectedExchange = "binance", environment = "testnet")
        state = state.updateCurrentCredentials(apiKey = "binance_test_key", apiSecret = "binance_test_sec")

        // Switch away to Bybit Mainnet and add Bybit key
        state = state.selectExchange("bybit").selectEnvironment("mainnet")
        state = state.updateCurrentCredentials(apiKey = "bybit_main_key", apiSecret = "bybit_main_sec")

        assertEquals("bybit_main_key", state.apiKey)

        // Switch back to Binance Testnet
        state = state.selectExchange("binance").selectEnvironment("testnet")

        // Binance Testnet credentials restored intact
        assertEquals("binance_test_key", state.apiKey)
        assertEquals("binance_test_sec", state.apiSecret)
    }

    @Test
    fun `test F - Passphrase is isolated per exchange and environment slot`() {
        var state = ExchangeFormState(selectedExchange = "kucoin", environment = "mainnet")
        state = state.updateCurrentCredentials(apiKey = "kc_key", apiSecret = "kc_sec", apiPassphrase = "secret_passphrase")

        assertEquals("secret_passphrase", state.apiPassphrase)

        // Switch environment to testnet
        state = state.selectEnvironment("testnet")
        assertEquals("", state.apiPassphrase)

        // Switch back to mainnet
        state = state.selectEnvironment("mainnet")
        assertEquals("secret_passphrase", state.apiPassphrase)
    }
}
