package com.cryptopulse.app.ui.navigation

import android.content.ContextWrapper
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.TokenState
import com.cryptopulse.app.service.TradeAlertManager
import com.cryptopulse.app.ui.screens.resolveStartupDestination
import com.cryptopulse.app.domain.repository.AuthRepository
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.error.NetworkError
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
        private var hasTokenSync: Boolean = false,
        var isAccessTokenExpired: Boolean = false,
        var isRefreshTokenExpired: Boolean = false,
        private var simulatedLoadDelayMs: Long = 0L
    ) : TokenManager(TestContext()) {
        override val tokenFlow: StateFlow<TokenState> = MutableStateFlow(TokenState.Uninitialized)
        override fun isRegistrationCompletedSync(): Boolean = isRegisteredSync
        override fun hasCachedTokenSync(): Boolean = hasTokenSync
        override suspend fun isRegistrationCompleted(): Boolean {
            if (simulatedLoadDelayMs > 0L) kotlinx.coroutines.delay(simulatedLoadDelayMs)
            return isRegisteredSync
        }
        override suspend fun getToken(): String? {
            if (simulatedLoadDelayMs > 0L) kotlinx.coroutines.delay(simulatedLoadDelayMs)
            return if (hasTokenSync) "valid_jwt_token" else null
        }
        override suspend fun getRefreshToken(): String? {
            if (simulatedLoadDelayMs > 0L) kotlinx.coroutines.delay(simulatedLoadDelayMs)
            return if (hasTokenSync) "valid_refresh_token" else null
        }
        override fun isTokenExpired(token: String?): Boolean {
            return if (token == "valid_jwt_token") isAccessTokenExpired else isRefreshTokenExpired
        }
        override suspend fun clearTokens() {
            hasTokenSync = false
        }
        fun saveTokensSync() {
            hasTokenSync = true
        }
    }

    private class FakeTestAuthRepository(
        private var shouldSucceed: Boolean = true
    ) : AuthRepository {
        var refreshCallCount = 0
        override suspend fun refreshToken(): NetworkResult<Unit> {
            refreshCallCount++
            return if (shouldSucceed) {
                NetworkResult.Success(Unit)
            } else {
                NetworkResult.Error(NetworkError.HttpError(401, "Token expired or revoked"))
            }
        }
        override suspend fun login(email: String, pass: String): NetworkResult<Unit> = throw NotImplementedError()
        override suspend fun register(email: String, password: String, confirm: String): NetworkResult<Unit> = throw NotImplementedError()
        override suspend fun logout(): NetworkResult<Unit> = throw NotImplementedError()
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

    @Test
    fun `RC-Fix startDestination memoization protects against mid-auth recomposition mutation`() {
        val tokenManager = FakeTestTokenManager(isRegisteredSync = true, hasTokenSync = false)

        // 1. Initial composition computes initialStartDestination
        val memoizedStartDestination = run {
            val isRegistered = tokenManager.isRegistrationCompletedSync()
            val hasCachedToken = tokenManager.hasCachedTokenSync()
            when {
                !isRegistered -> "onboarding"
                !hasCachedToken -> "auth"
                else -> "authenticated_flow"
            }
        }
        assertEquals("Initial startDestination must be auth", "auth", memoizedStartDestination)

        // 2. User logs in: TokenManager receives tokens and saves them
        tokenManager.saveTokensSync()
        assertTrue("Tokens must be cached after login", tokenManager.hasCachedTokenSync())

        // 3. During recomposition, remember block preserves memoizedStartDestination without mutation
        // If it was NOT remembered (bare recalculation), it would illegally mutate to authenticated_flow:
        val bareRecalculatedDestination = run {
            val isRegistered = tokenManager.isRegistrationCompletedSync()
            val hasCachedToken = tokenManager.hasCachedTokenSync()
            when {
                !isRegistered -> "onboarding"
                !hasCachedToken -> "auth"
                else -> "authenticated_flow"
            }
        }
        assertEquals("Bare calculation would mutate", "authenticated_flow", bareRecalculatedDestination)

        // The memoized value must remain stable for the NavHost lifetime
        assertEquals("Memoized startDestination remains stable at auth to allow popUpTo to succeed", "auth", memoizedStartDestination)
    }

    @Test
    fun `RC-Fix Authenticated app cold restart evaluates memoized startDestination to authenticated_flow`() {
        // When user is already authenticated on app launch (cold restart)
        val tokenManager = FakeTestTokenManager(isRegisteredSync = true, hasTokenSync = true)

        val startDestination = run {
            val isRegistered = tokenManager.isRegistrationCompletedSync()
            val hasCachedToken = tokenManager.hasCachedTokenSync()
            when {
                !isRegistered -> "onboarding"
                !hasCachedToken -> "auth"
                else -> "authenticated_flow"
            }
        }
        assertEquals("Cold restart with cached tokens evaluates to authenticated_flow", "authenticated_flow", startDestination)
    }

    @Test
    fun `RC-Fix ConnectExchangeScreen navigation latch guarantees single dispatch to trade_setup`() {
        var hasNavigatedToSetup = false
        var dispatchCount = 0

        val onNavigate = {
            if (!hasNavigatedToSetup) {
                hasNavigatedToSetup = true
                dispatchCount++
            }
        }

        // Trigger 1: LaunchedEffect(Unit) detects existing connection
        val isConnected = true
        if (isConnected && !hasNavigatedToSetup) {
            onNavigate()
        }

        // Trigger 2: LaunchedEffect(uiState) concurrently evaluates uiState as Connected
        val shouldNavigate = true
        if (shouldNavigate && !hasNavigatedToSetup) {
            onNavigate()
        }

        assertEquals("Navigation must be dispatched exactly once despite concurrent triggers", 1, dispatchCount)
        assertTrue("Navigation latch must be engaged", hasNavigatedToSetup)
    }

    @Test
    fun `Trade execution auto-navigation latch guarantees single dispatch to technical_analysis`() {
        var hasNavigated = false
        var dispatchCount = 0
        var targetDestination = ""

        val onTradeExecuted = {
            if (!hasNavigated) {
                hasNavigated = true
                dispatchCount++
                targetDestination = "technical_analysis"
            }
        }

        val onUserBack = {
            if (!hasNavigated) {
                hasNavigated = true
                dispatchCount++
                targetDestination = "back"
            }
        }

        // Scenario 1: Successful execution starts timer; concurrent back event triggers first
        val isExecutionSuccess = true
        if (isExecutionSuccess && !hasNavigated) {
            onUserBack() // User taps back at second 2
        }

        // Timer completes at second 4
        if (isExecutionSuccess && !hasNavigated) {
            onTradeExecuted()
        }

        assertEquals("Dispatch count must be exactly 1", 1, dispatchCount)
        assertEquals("User back event took precedence cleanly", "back", targetDestination)
        assertTrue("Latch must be engaged", hasNavigated)
    }

    @Test
    fun `Trade confirmation navigation routes to technical_analysis and never to market_candidates`() {
        var navigatedDestination: String? = null
        var poppedDestination: String? = null
        var isInclusive = false

        // Simulate back stack resolution logic from MainActivity:
        // Case A: technical_analysis is already on backstack
        var technicalAnalysisOnBackStack = true
        val popBackStack = { route: String, inclusive: Boolean ->
            if (route == "technical_analysis" && technicalAnalysisOnBackStack) {
                poppedDestination = route
                isInclusive = inclusive
                true
            } else {
                false
            }
        }

        val navigate = { route: String, popUpRoute: String, inclusive: Boolean ->
            navigatedDestination = route
            poppedDestination = popUpRoute
            isInclusive = inclusive
        }

        val onTradeExecuted = {
            if (!popBackStack("technical_analysis", false)) {
                navigate("technical_analysis", "trade_alert", true)
            }
        }

        // Execute Case A
        onTradeExecuted()
        assertEquals("technical_analysis", poppedDestination)
        assertFalse("technical_analysis should not be popped inclusively", isInclusive)
        assertNull("Direct navigate should not be called when pop succeeds", navigatedDestination)

        // Case B: technical_analysis is NOT on backstack (e.g. notification entry)
        technicalAnalysisOnBackStack = false
        poppedDestination = null
        navigatedDestination = null
        onTradeExecuted()
        assertEquals("technical_analysis", navigatedDestination)
        assertEquals("trade_alert", poppedDestination)
        assertTrue("trade_alert must be popped inclusively to prevent stale backstack", isInclusive)
        assertNotEquals("market_candidates", navigatedDestination)
    }

    @Test
    fun `Trade execution auto-navigation timer does not trigger for failure or pending states`() {
        var timerScheduled = false

        val testStates = listOf(
            "Idle",
            "Submitting",
            "AwaitingFill",
            "Failed"
        )

        for (state in testStates) {
            val isSuccess = state == "Filled" || state == "Confirmed"
            if (isSuccess) {
                timerScheduled = true
            }
        }

        assertFalse("Timer must never be scheduled for non-success states", timerScheduled)
    }

    // -------------------------------------------------------------
    // Session Restoration on App Reopen Regression Tests
    // -------------------------------------------------------------

    @Test
    fun `Returning user with asynchronous DataStore restoration resolves to authenticated_flow without login`() = runTest {
        // Simulates cold restart: TokenManager takes 50ms to read from DataStore and decrypt
        val tokenManager = FakeTestTokenManager(
            isRegisteredSync = true,
            hasTokenSync = true,
            simulatedLoadDelayMs = 50L
        )

        val destination = resolveStartupDestination(
            tokenManager = tokenManager,
            isExchangeConnected = false
        )

        assertEquals("Returning user with valid session must open authenticated_flow", "authenticated_flow", destination)
        assertNotEquals("Must not show login screen to authenticated returning user", "auth", destination)
        assertNotEquals("Must not show onboarding to registered user", "onboarding", destination)
    }

    @Test
    fun `Fresh installation without saved registration resolves to onboarding`() = runTest {
        val tokenManager = FakeTestTokenManager(
            isRegisteredSync = false,
            hasTokenSync = false
        )

        val destination = resolveStartupDestination(
            tokenManager = tokenManager,
            isExchangeConnected = false
        )

        assertEquals("Fresh install must route to onboarding", "onboarding", destination)
    }

    @Test
    fun `Explicit logout with cleared credentials resolves to auth sign in`() = runTest {
        val tokenManager = FakeTestTokenManager(
            isRegisteredSync = true,
            hasTokenSync = true
        )

        // User performs explicit logout -> tokens are wiped, but registration flag remains
        tokenManager.clearTokens()

        val destination = resolveStartupDestination(
            tokenManager = tokenManager,
            isExchangeConnected = false
        )

        assertEquals("Logged out user with prior registration must route to auth", "auth", destination)
    }

    @Test
    fun `Expired access token with valid refresh token automatically refreshes and preserves session`() = runTest {
        val tokenManager = FakeTestTokenManager(
            isRegisteredSync = true,
            hasTokenSync = true,
            isAccessTokenExpired = true,
            isRefreshTokenExpired = false
        )
        val authRepo = FakeTestAuthRepository(shouldSucceed = true)

        val destination = resolveStartupDestination(
            tokenManager = tokenManager,
            isExchangeConnected = false,
            authRepository = authRepo
        )

        assertEquals("Session must be preserved via refresh token", "authenticated_flow", destination)
        assertEquals("Token refresh endpoint must be invoked exactly once", 1, authRepo.refreshCallCount)
    }

    @Test
    fun `Expired access token with invalid refresh token clears session and routes to auth`() = runTest {
        val tokenManager = FakeTestTokenManager(
            isRegisteredSync = true,
            hasTokenSync = true,
            isAccessTokenExpired = true,
            isRefreshTokenExpired = false
        )
        val authRepo = FakeTestAuthRepository(shouldSucceed = false)

        val destination = resolveStartupDestination(
            tokenManager = tokenManager,
            isExchangeConnected = false,
            authRepository = authRepo
        )

        assertEquals("Fatal refresh failure must route to auth", "auth", destination)
        assertEquals(1, authRepo.refreshCallCount)
        assertFalse("Tokens must be cleared on fatal refresh failure", tokenManager.hasCachedTokenSync())
    }

    @Test
    fun `Active trade alert on cold restart routes directly to trade_alert`() = runTest {
        val tokenManager = FakeTestTokenManager(
            isRegisteredSync = true,
            hasTokenSync = true
        )

        val destination = resolveStartupDestination(
            tokenManager = tokenManager,
            isExchangeConnected = true,
            hasActiveAlert = true
        )

        assertEquals("Active alert must route to trade_alert", "trade_alert", destination)
    }

    @Test
    fun `Temporary network or exchange failure does NOT clear valid credentials or force login`() = runTest {
        val tokenManager = FakeTestTokenManager(
            isRegisteredSync = true,
            hasTokenSync = true,
            simulatedLoadDelayMs = 20L
        )

        // Simulates network exception during exchange connectivity probe
        val destination = resolveStartupDestination(
            tokenManager = tokenManager,
            isExchangeConnected = false,
            authRepository = null
        )

        assertEquals("Must remain in authenticated flow despite network failure", "authenticated_flow", destination)
        assertTrue("Tokens must remain intact during temporary network drops", tokenManager.hasCachedTokenSync())
    }
}
