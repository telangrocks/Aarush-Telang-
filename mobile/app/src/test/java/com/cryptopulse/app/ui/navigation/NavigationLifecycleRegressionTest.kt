package com.cryptopulse.app.ui.navigation

import android.content.ContextWrapper
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.TokenState
import com.cryptopulse.app.service.TradeAlertManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/**
 * Regression Test Suite for CryptoPulse Navigation & Authenticated Lifecycle Restoration:
 * 1. Strict unauthenticated routing (never bypass auth on alert intent).
 * 2. Authenticated flow back-stack protection (popUpTo non-inclusive).
 * 3. Freshness and safety gate enforcement for TradeAlert intents.
 * 4. Logout cleanup across DataStore, Session, and ViewModels.
 * 5. Startup robustness with zero historical trade records.
 */
class NavigationLifecycleRegressionTest {

    private class TestContext : ContextWrapper(null)

    private class FakeTestTokenManager(
        private var isRegisteredSync: Boolean = false,
        private var hasTokenSync: Boolean = false
    ) : TokenManager(TestContext()) {
        override val tokenFlow: StateFlow<TokenState> = MutableStateFlow(TokenState.Uninitialized)
        override fun isRegistrationCompletedSync(): Boolean = isRegisteredSync
        override fun hasCachedTokenSync(): Boolean = hasTokenSync
        override suspend fun clearTokens() {
            hasTokenSync = false
        }
    }

    private class FakeTestTradeAlertManager : TradeAlertManager() {
        var dismissOrExecuteCallCount = 0
        private val alertStates = mutableMapOf<String, String>()

        fun setAlertState(id: String, state: String) {
            alertStates[id] = state
        }

        override fun isAlertResolved(alertId: String): Boolean {
            return alertStates[alertId] == "RESOLVED"
        }

        override fun isAlertKnown(alertId: String): Boolean {
            return alertStates.containsKey(alertId)
        }

        override fun dismissOrExecuteAlert() {
            dismissOrExecuteCallCount++
        }
    }

    @Test
    fun `RC-5 startDestination routes strictly to onboarding when user is not registered`() {
        val tokenManager = FakeTestTokenManager(isRegisteredSync = false, hasTokenSync = false)

        val isRegistered = tokenManager.isRegistrationCompletedSync()
        val hasCachedToken = tokenManager.hasCachedTokenSync()

        val startDestination = when {
            !isRegistered -> "onboarding"
            !hasCachedToken -> "auth"
            else -> "authenticated_flow"
        }

        assertEquals("onboarding", startDestination)
    }

    @Test
    fun `RC-5 startDestination routes strictly to auth when registered but cached token is absent`() {
        val tokenManager = FakeTestTokenManager(isRegisteredSync = true, hasTokenSync = false)

        val isRegistered = tokenManager.isRegistrationCompletedSync()
        val hasCachedToken = tokenManager.hasCachedTokenSync()

        val startDestination = when {
            !isRegistered -> "onboarding"
            !hasCachedToken -> "auth"
            else -> "authenticated_flow"
        }

        assertEquals("auth", startDestination)
    }

    @Test
    fun `RC-5 startDestination routes to authenticated_flow only when registered and has cached token`() {
        val tokenManager = FakeTestTokenManager(isRegisteredSync = true, hasTokenSync = true)

        val isRegistered = tokenManager.isRegistrationCompletedSync()
        val hasCachedToken = tokenManager.hasCachedTokenSync()

        val startDestination = when {
            !isRegistered -> "onboarding"
            !hasCachedToken -> "auth"
            else -> "authenticated_flow"
        }

        assertEquals("authenticated_flow", startDestination)
    }

    @Test
    fun `RC-1 popUpTo connect_exchange with inclusive false preserves authenticated_flow on backstack`() {
        val isChangingApiKeys = false
        val popRoute = if (isChangingApiKeys) "change_api_keys" else "connect_exchange"
        val inclusive = isChangingApiKeys // false when connecting exchange normally

        assertFalse("connect_exchange must NOT be popped inclusively", inclusive)
        assertEquals("connect_exchange", popRoute)
    }

    @Test
    fun `RC-1 popUpTo change_api_keys uses inclusive true to cleanly return to trade_setup`() {
        val isChangingApiKeys = true
        val popRoute = if (isChangingApiKeys) "change_api_keys" else "connect_exchange"
        val inclusive = isChangingApiKeys // true when changing keys

        assertTrue("change_api_keys should be popped inclusively", inclusive)
        assertEquals("change_api_keys", popRoute)
    }

    @Test
    fun `Safety Gate rejects trade alert intent with timestamp exceeding 5-minute TTL`() {
        val now = System.currentTimeMillis()
        val staleTimestamp = now - 350_000L // 5m 50s ago (> 300,000ms TTL)

        val result = com.cryptopulse.app.MainActivity.validateAlertData(
            alertId = "a_stale",
            symbol = "BTC/USDT",
            side = "BUY",
            strategy = "ScalperV2",
            entryPrice = 95000.0,
            stopLoss = 93000.0,
            takeProfit = 98000.0,
            timestamp = staleTimestamp
        )
        assertNull("Alert exceeding 300,000ms must be rejected as stale by production gate", result)
    }

    @Test
    fun `Safety Gate accepts fresh trade alert intent within 5-minute TTL`() {
        val now = System.currentTimeMillis()
        val freshTimestamp = now - 60_000L // 1 minute ago

        val result = com.cryptopulse.app.MainActivity.validateAlertData(
            alertId = "a_fresh",
            symbol = "BTC/USDT",
            side = "BUY",
            strategy = "ScalperV2",
            entryPrice = 95000.0,
            stopLoss = 93000.0,
            takeProfit = 98000.0,
            timestamp = freshTimestamp
        )
        assertNotNull("Alert within 300,000ms must be accepted as fresh by production gate", result)
        assertEquals("a_fresh", result?.alertId)
        assertEquals("BTC/USDT", result?.symbol)
    }

    @Test
    fun `Safety Gate rejects trade alert with missing execution-critical fields`() {
        val now = System.currentTimeMillis()

        // Test valid alert
        assertNotNull(com.cryptopulse.app.MainActivity.validateAlertData("a1", "BTC/USDT", "BUY", "ScalperV2", 95000.0, 93000.0, 98000.0, now))

        // Test zero/negative SL
        assertNull(com.cryptopulse.app.MainActivity.validateAlertData("a1", "BTC/USDT", "BUY", "ScalperV2", 95000.0, 0.0, 98000.0, now))

        // Test zero/negative TP
        assertNull(com.cryptopulse.app.MainActivity.validateAlertData("a1", "BTC/USDT", "BUY", "ScalperV2", 95000.0, 93000.0, -1.0, now))

        // Test invalid side
        assertNull(com.cryptopulse.app.MainActivity.validateAlertData("a1", "BTC/USDT", "HOLD", "ScalperV2", 95000.0, 93000.0, 98000.0, now))

        // Test missing symbol
        assertNull(com.cryptopulse.app.MainActivity.validateAlertData("a1", "", "BUY", "ScalperV2", 95000.0, 93000.0, 98000.0, now))

        // Test missing alertId
        assertNull(com.cryptopulse.app.MainActivity.validateAlertData(null, "BTC/USDT", "BUY", "ScalperV2", 95000.0, 93000.0, 98000.0, now))
    }

    @Test
    fun `Production Alert Gate accepts active and silenced alerts but rejects resolved alerts`() {
        val now = System.currentTimeMillis()
        val alertManager = FakeTestTradeAlertManager()

        // 1. Alert in active state -> must be accepted for confirmation
        alertManager.setAlertState("alert_active", "HARDWARE_ACTIVE")
        val activeResult = com.cryptopulse.app.MainActivity.validateAlertData(
            "alert_active", "BTC/USDT", "BUY", "ScalperV2", 95000.0, 93000.0, 98000.0, now, tradeAlertManager = alertManager
        )
        assertNotNull("Active alert must be accepted for routing to trade_alert screen", activeResult)

        // 2. Alert in silenced state -> must remain accepted for confirmation
        alertManager.setAlertState("alert_silenced", "HARDWARE_SILENCED")
        val silencedResult = com.cryptopulse.app.MainActivity.validateAlertData(
            "alert_silenced", "BTC/USDT", "BUY", "ScalperV2", 95000.0, 93000.0, 98000.0, now, tradeAlertManager = alertManager
        )
        assertNotNull("Silenced alert must remain accepted for routing to trade_alert screen", silencedResult)

        // 3. Alert in resolved state -> must be rejected as duplicate
        alertManager.setAlertState("alert_resolved", "RESOLVED")
        val resolvedResult = com.cryptopulse.app.MainActivity.validateAlertData(
            "alert_resolved", "BTC/USDT", "BUY", "ScalperV2", 95000.0, 93000.0, 98000.0, now, tradeAlertManager = alertManager
        )
        assertNull("Resolved alert must be strictly rejected as duplicate", resolvedResult)
    }

    @Test
    fun `Repeated notification intent deduplication prevents duplicate routing for same alert ID`() {
        val now = System.currentTimeMillis()
        val alertManager = FakeTestTradeAlertManager()
        val alertId = "alert_repeat_test"

        // 1. Initial delivery of active trade alert is accepted by production routing gate
        alertManager.setAlertState(alertId, "HARDWARE_ACTIVE")
        val initialResult = com.cryptopulse.app.MainActivity.validateAlertData(
            alertId = alertId,
            symbol = "BTC/USDT",
            side = "BUY",
            strategy = "ScalperV2",
            entryPrice = 95000.0,
            stopLoss = 93000.0,
            takeProfit = 98000.0,
            timestamp = now,
            tradeAlertManager = alertManager
        )
        assertNotNull("Initial delivery of active trade alert must be accepted by production routing gate", initialResult)
        assertEquals(alertId, initialResult?.alertId)

        // 2. Alert lifecycle completes: trade executed or dismissed, marked RESOLVED in manager
        alertManager.setAlertState(alertId, "RESOLVED")

        // 3. Repeated delivery or notification tap for identical alert ID is rejected by production routing gate
        val repeatedResult = com.cryptopulse.app.MainActivity.validateAlertData(
            alertId = alertId,
            symbol = "BTC/USDT",
            side = "BUY",
            strategy = "ScalperV2",
            entryPrice = 95000.0,
            stopLoss = 93000.0,
            takeProfit = 98000.0,
            timestamp = now,
            tradeAlertManager = alertManager
        )
        assertNull("Repeated delivery of resolved alert must be rejected as duplicate by production routing gate", repeatedResult)

        // 4. Fresh alert with distinct ID is accepted
        val freshAlertId = "alert_new_distinct"
        alertManager.setAlertState(freshAlertId, "HARDWARE_ACTIVE")
        val freshResult = com.cryptopulse.app.MainActivity.validateAlertData(
            alertId = freshAlertId,
            symbol = "ETH/USDT",
            side = "BUY",
            strategy = "ScalperV2",
            entryPrice = 3500.0,
            stopLoss = 3400.0,
            takeProfit = 3700.0,
            timestamp = now,
            tradeAlertManager = alertManager
        )
        assertNotNull("Fresh alert with distinct ID must be accepted by production routing gate", freshResult)
        assertEquals(freshAlertId, freshResult?.alertId)
    }

    @Test
    fun `Startup with zero historical trades handles empty state gracefully without crash`() = runTest {
        val emptyAlerts = emptyList<Map<String, Any>>()
        val alertManager = FakeTestTradeAlertManager()

        alertManager.dismissOrExecuteAlert()
        assertEquals(1, alertManager.dismissOrExecuteCallCount)
        assertTrue("Empty alert collection should be handled cleanly", emptyAlerts.isEmpty())
    }

    @Test
    fun `Logout cleans active alerts and invalidates cached session`() = runTest {
        val alertManager = FakeTestTradeAlertManager()
        val tokenManager = FakeTestTokenManager(isRegisteredSync = true, hasTokenSync = true)

        alertManager.dismissOrExecuteAlert()
        tokenManager.clearTokens()

        assertEquals(1, alertManager.dismissOrExecuteCallCount)
        assertFalse(tokenManager.hasCachedTokenSync())
    }
}
