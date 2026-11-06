package com.cryptopulse.app.data.session

import android.content.Context
import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.domain.repository.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

@OptIn(ExperimentalCoroutinesApi::class)
class SessionManagerTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var dispatcherProvider: DispatcherProvider
    private lateinit var fakeAuthRepo: FakeAuthRepoForSession
    private lateinit var fakeBotRepo: FakeBotRepoForSession
    private lateinit var fakeTradeSessionRepo: FakeTradeSessionRepoForSession
    private lateinit var fakeExchangeConnectionManager: FakeExchangeConnectionManagerForSession
    private lateinit var fakeStrategyRepo: FakeStrategyRepoForSession
    private lateinit var fakeTokenManager: FakeTokenManagerForSession
    private lateinit var fakeFcmRepo: FakeFcmRepoForSession
    private lateinit var sessionManager: SessionManager

    @Before
    fun setup() {
        dispatcherProvider = object : DispatcherProvider {
            override val main: CoroutineDispatcher = testDispatcher
            override val io: CoroutineDispatcher = testDispatcher
            override val default: CoroutineDispatcher = testDispatcher
            override val unconfined: CoroutineDispatcher = testDispatcher
        }
        fakeAuthRepo = FakeAuthRepoForSession()
        fakeBotRepo = FakeBotRepoForSession()
        fakeTradeSessionRepo = FakeTradeSessionRepoForSession()
        fakeExchangeConnectionManager = FakeExchangeConnectionManagerForSession()
        fakeStrategyRepo = FakeStrategyRepoForSession()
        fakeTokenManager = FakeTokenManagerForSession()
        fakeFcmRepo = FakeFcmRepoForSession()

        fakeAuthRepo.tokenManagerRef = fakeTokenManager

        sessionManager = SessionManager(
            authRepository = fakeAuthRepo,
            botRepository = fakeBotRepo,
            tradeSessionRepository = fakeTradeSessionRepo,
            exchangeConnectionManager = fakeExchangeConnectionManager,
            strategyRepository = fakeStrategyRepo,
            tokenManager = fakeTokenManager,
            dispatcherProvider = dispatcherProvider,
            fcmRepository = fakeFcmRepo
        )
    }

    @Test
    fun `performLogout halts polling, clears caches, clears trade session, notifies backend, and wipes tokens`() = runTest(testDispatcher) {
        fakeBotRepo.isObserving = true
        fakeTokenManager.hasTokens = true
        fakeTradeSessionRepo.hasSession = true
        fakeStrategyRepo.hasCache = true
        fakeExchangeConnectionManager.hasConnection = true

        val result = sessionManager.performLogout(FakeContextForSession())

        assertTrue("Bot deactivation must be requested", fakeBotRepo.deactivateBotCalled)
        assertTrue("Bot observation must be stopped", fakeBotRepo.stopObservingCalled)
        assertTrue("Trade session must be cleared", fakeTradeSessionRepo.clearSessionCalled)
        assertTrue("Strategy cache must be cleared", fakeStrategyRepo.clearCacheCalled)
        assertTrue("Exchange credentials must be cleared", fakeExchangeConnectionManager.clearConnectionCalled)
        assertTrue("Backend logout must be invoked", fakeAuthRepo.logoutCalled)
        assertTrue("Tokens must be wiped", fakeTokenManager.clearTokensCalled)
        assertTrue("FCM registration must be cleared", fakeFcmRepo.clearRegistrationStateCalled)
        assertEquals(BackendLogoutOutcome.ConfirmedSuccess, result.backendOutcome)
        assertTrue(result.localCleanup.allRequiredOperationsSucceeded)
    }

    @Test
    fun `concurrent performLogout calls execute safely and idempotently`() = runTest(testDispatcher) {
        fakeBotRepo.deactivateDelayMs = 50L
        repeat(5) {
            launch {
                sessionManager.performLogout(FakeContextForSession())
            }
        }
        advanceUntilIdle()

        assertEquals(1, fakeAuthRepo.logoutCount.get())
        assertEquals(1, fakeBotRepo.stopObservingCount.get())
    }

    @Test
    fun `performLogout returns ConfirmedSuccess and allRequiredOperationsSucceeded on backend 200`() = runTest(testDispatcher) {
        fakeAuthRepo.logoutResult = NetworkResult.Success(Unit)

        val result = sessionManager.performLogout(FakeContextForSession())

        assertEquals(BackendLogoutOutcome.ConfirmedSuccess, result.backendOutcome)
        assertTrue(result.localCleanup.allRequiredOperationsSucceeded)
        assertTrue(result.localCleanup.tokensCleared)
        assertNull(result.localCleanup.tokenClearException)
    }

    @Test
    fun `performLogout returns ConfirmedRejection on HTTP 401 and still completes local cleanup`() = runTest(testDispatcher) {
        fakeAuthRepo.logoutResult = NetworkResult.Error(
            NetworkError.HttpError(code = 401, message = "Token has been revoked")
        )

        val result = sessionManager.performLogout(FakeContextForSession())

        val outcome = result.backendOutcome as BackendLogoutOutcome.ConfirmedRejection
        assertEquals(401, outcome.code)
        assertEquals("Token has been revoked", outcome.reason)
        assertTrue(result.localCleanup.allRequiredOperationsSucceeded)
        assertTrue(result.localCleanup.tokensCleared)
    }

    @Test
    fun `performLogout returns ServerResponseIndeterminate on HTTP 403, 404, 405`() = runTest(testDispatcher) {
        listOf(403, 404, 405).forEach { code ->
            fakeAuthRepo.logoutResult = NetworkResult.Error(
                NetworkError.HttpError(code = code, message = "Route or permission rejected")
            )

            val result = sessionManager.performLogout(FakeContextForSession())

            val outcome = result.backendOutcome as BackendLogoutOutcome.ServerResponseIndeterminate
            assertEquals(code, outcome.code)
            assertTrue(result.localCleanup.tokensCleared)
        }
    }

    @Test
    fun `performLogout returns ServerResponseIndeterminate on HTTP 500 and still completes local cleanup`() = runTest(testDispatcher) {
        fakeAuthRepo.logoutResult = NetworkResult.Error(
            NetworkError.HttpError(code = 500, message = "Internal database transaction failure")
        )

        val result = sessionManager.performLogout(FakeContextForSession())

        val outcome = result.backendOutcome as BackendLogoutOutcome.ServerResponseIndeterminate
        assertEquals(500, outcome.code)
        assertTrue(result.localCleanup.allRequiredOperationsSucceeded)
        assertTrue(result.localCleanup.tokensCleared)
    }

    @Test
    fun `performLogout returns NetworkTimeoutIndeterminate on timeout and completes local cleanup`() = runTest(testDispatcher) {
        fakeAuthRepo.logoutResult = NetworkResult.Error(NetworkError.Timeout)

        val result = sessionManager.performLogout(FakeContextForSession())

        assertEquals(BackendLogoutOutcome.NetworkTimeoutIndeterminate, result.backendOutcome)
        assertTrue(result.localCleanup.allRequiredOperationsSucceeded)
        assertTrue(result.localCleanup.tokensCleared)
    }

    @Test
    fun `performLogout returns NetworkFailureIndeterminate on network IO exception and completes local cleanup`() = runTest(testDispatcher) {
        val ioException = IOException("No internet connection")
        fakeAuthRepo.logoutResult = NetworkResult.Error(NetworkError.Unknown(ioException))

        val result = sessionManager.performLogout(FakeContextForSession())

        val outcome = result.backendOutcome as BackendLogoutOutcome.NetworkFailureIndeterminate
        assertEquals(ioException, outcome.cause)
        assertTrue(result.localCleanup.allRequiredOperationsSucceeded)
        assertTrue(result.localCleanup.tokensCleared)
    }

    @Test
    fun `performLogout when parent cancelled during bot deactivation skips server logout, executes NonCancellable local cleanup, and rethrows cancellation`() = runTest(testDispatcher) {
        fakeBotRepo.deactivateDelayMs = 200L

        var caughtCancellation: CancellationException? = null
        val job = launch {
            try {
                sessionManager.performLogout(FakeContextForSession())
            } catch (e: CancellationException) {
                caughtCancellation = e
                throw e
            }
        }

        testScheduler.advanceTimeBy(50L)
        job.cancel()
        advanceUntilIdle()

        assertNotNull("CancellationException must be rethrown", caughtCancellation)
        assertFalse("Server logout must NOT be dispatched if cancelled before dispatch", fakeAuthRepo.logoutCalled)
        assertTrue("Bot observation must still be stopped in NonCancellable", fakeBotRepo.stopObservingCalled)
        assertTrue("Trade session must still be cleared in NonCancellable", fakeTradeSessionRepo.clearSessionCalled)
        assertTrue("Tokens must still be wiped in NonCancellable", fakeTokenManager.clearTokensCalled)
    }

    @Test
    fun `performLogout when parent cancelled during server logout records CancellationIndeterminate, executes NonCancellable local cleanup, and rethrows cancellation`() = runTest(testDispatcher) {
        fakeAuthRepo.logoutDelayMs = 200L

        var caughtCancellation: CancellationException? = null
        val job = launch {
            try {
                sessionManager.performLogout(FakeContextForSession())
            } catch (e: CancellationException) {
                caughtCancellation = e
                throw e
            }
        }

        testScheduler.advanceTimeBy(50L)
        job.cancel()
        advanceUntilIdle()

        assertNotNull("CancellationException must be rethrown", caughtCancellation)
        assertTrue("Server logout must have been entered", fakeAuthRepo.logoutCalled)
        assertTrue("Tokens must still be wiped in NonCancellable", fakeTokenManager.clearTokensCalled)
        assertTrue("Trade session must still be cleared in NonCancellable", fakeTradeSessionRepo.clearSessionCalled)
    }

    @Test
    fun `performLogout with FCM not configured reports NOT_CONFIGURED and overall success`() = runTest(testDispatcher) {
        val sessionManagerWithoutFcm = SessionManager(
            authRepository = fakeAuthRepo,
            botRepository = fakeBotRepo,
            tradeSessionRepository = fakeTradeSessionRepo,
            exchangeConnectionManager = fakeExchangeConnectionManager,
            strategyRepository = fakeStrategyRepo,
            tokenManager = fakeTokenManager,
            dispatcherProvider = dispatcherProvider,
            fcmRepository = null
        )

        val result = sessionManagerWithoutFcm.performLogout(FakeContextForSession())

        assertEquals(FcmCleanupOutcome.NOT_CONFIGURED, result.localCleanup.fcmCleanupOutcome)
        assertTrue("Overall success should be true when optional FCM is not configured", result.localCleanup.allRequiredOperationsSucceeded)
        assertTrue(result.localCleanup.tokensCleared)
    }

    @Test
    fun `performLogout with FCM configured reports SUCCESS and overall success`() = runTest(testDispatcher) {
        val result = sessionManager.performLogout(FakeContextForSession())

        assertEquals(FcmCleanupOutcome.SUCCESS, result.localCleanup.fcmCleanupOutcome)
        assertTrue(fakeFcmRepo.clearRegistrationStateCalled)
        assertTrue(result.localCleanup.allRequiredOperationsSucceeded)
    }

    @Test
    fun `performLogout with FCM failing reports FAILED, overall failure, but still clears tokens`() = runTest(testDispatcher) {
        fakeFcmRepo.shouldThrow = true

        val result = sessionManager.performLogout(FakeContextForSession())

        assertEquals(FcmCleanupOutcome.FAILED, result.localCleanup.fcmCleanupOutcome)
        assertFalse(result.localCleanup.allRequiredOperationsSucceeded)
        assertTrue("Tokens must still be wiped even when FCM cleanup fails", result.localCleanup.tokensCleared)
        assertTrue(fakeTokenManager.clearTokensCalled)
    }

    @Test
    fun `performLogout with individual repository failures isolates errors and still wipes tokens`() = runTest(testDispatcher) {
        fakeTradeSessionRepo.shouldThrow = true
        fakeStrategyRepo.shouldThrow = true
        fakeExchangeConnectionManager.shouldThrow = true

        val result = sessionManager.performLogout(FakeContextForSession())

        assertFalse(result.localCleanup.tradeSessionCleared)
        assertFalse(result.localCleanup.strategyCacheCleared)
        assertFalse(result.localCleanup.exchangeConnectionCleared)
        assertTrue("Bot observation must still be stopped", result.localCleanup.botObservationStopped)
        assertTrue("Tokens must still be wiped", result.localCleanup.tokensCleared)
        assertFalse("Overall required operations should fail if trade session failed", result.localCleanup.allRequiredOperationsSucceeded)
    }

    @Test
    fun `performLogout with token clear failure records tokenClearException and reports tokensCleared false`() = runTest(testDispatcher) {
        val securityException = SecurityException("Keystore unavailable")
        fakeTokenManager.throwException = securityException

        val result = sessionManager.performLogout(FakeContextForSession())

        assertFalse(result.localCleanup.tokensCleared)
        assertEquals(securityException, result.localCleanup.tokenClearException)
        assertFalse(result.localCleanup.allRequiredOperationsSucceeded)
    }

    @Test
    fun `performLogout resets concurrency guard in finally allowing subsequent logout attempts`() = runTest(testDispatcher) {
        fakeTokenManager.throwException = RuntimeException("Unexpected error during local cleanup")

        // First attempt fails during token clear
        val firstResult = sessionManager.performLogout(FakeContextForSession())
        assertFalse(firstResult.localCleanup.tokensCleared)

        // Fix token manager for second attempt
        fakeTokenManager.throwException = null
        val secondResult = sessionManager.performLogout(FakeContextForSession())

        assertTrue("Guard must have been reset, allowing second attempt to proceed", secondResult.localCleanup.tokensCleared)
        assertNotEquals(BackendLogoutOutcome.SkippedConcurrentExecution, secondResult.backendOutcome)
    }

    @Test
    fun `performLogout records botDeactivationAttempted even when deactivation times out`() = runTest(testDispatcher) {
        fakeBotRepo.deactivateDelayMs = 5000L // Longer than 3000ms timeout

        val result = sessionManager.performLogout(FakeContextForSession())

        assertTrue("botDeactivationAttempted must be true even if timeout occurred", result.localCleanup.botDeactivationAttempted)
        assertTrue(result.localCleanup.tokensCleared)
    }

    @Test
    fun `performLogout records NetworkTimeoutIndeterminate when server logout exceeds 10-second timeout`() = runTest(testDispatcher) {
        fakeAuthRepo.logoutDelayMs = 15000L // Longer than 10000ms timeout

        val result = sessionManager.performLogout(FakeContextForSession())

        assertEquals(BackendLogoutOutcome.NetworkTimeoutIndeterminate, result.backendOutcome)
        assertTrue(result.localCleanup.tokensCleared)
        assertTrue(result.localCleanup.allRequiredOperationsSucceeded)
    }

    @Test
    fun `performLogout preserves token availability during server logout request`() = runTest(testDispatcher) {
        fakeTokenManager.hasTokens = true

        sessionManager.performLogout(FakeContextForSession())

        assertTrue("Token must have been present when server logout was dispatched", fakeAuthRepo.tokenStateDuringLogout == true)
        assertFalse("Token must be wiped after logout completes", fakeTokenManager.hasTokens)
    }
}

private class FakeAuthRepoForSession : AuthRepository {
    var logoutCalled = false
    val logoutCount = AtomicInteger(0)
    var logoutResult: NetworkResult<Unit> = NetworkResult.Success(Unit)
    var logoutDelayMs: Long = 0L
    var logoutException: Throwable? = null
    var tokenStateDuringLogout: Boolean? = null
    var tokenManagerRef: FakeTokenManagerForSession? = null

    override suspend fun login(email: String, password: String) = NetworkResult.Success(Unit)
    override suspend fun register(email: String, password: String, confirm: String) = NetworkResult.Success(Unit)
    override suspend fun logout(): NetworkResult<Unit> {
        logoutCalled = true
        logoutCount.incrementAndGet()
        tokenStateDuringLogout = tokenManagerRef?.hasTokens
        if (logoutDelayMs > 0) delay(logoutDelayMs)
        logoutException?.let { throw it }
        return logoutResult
    }
    override suspend fun refreshToken() = NetworkResult.Success(Unit)
}

private class FakeBotRepoForSession : BotRepository {
    var isObserving = false
    var stopObservingCalled = false
    var deactivateBotCalled = false
    var deactivateDelayMs: Long = 0L
    var deactivateBotException: Throwable? = null
    val stopObservingCount = AtomicInteger(0)

    override val analysisState: StateFlow<com.cryptopulse.app.domain.models.AnalysisSnapshot?> = MutableStateFlow(null)
    override val activeBotAnalysisState: StateFlow<com.cryptopulse.app.domain.models.AnalysisSnapshot?> = MutableStateFlow(null)
    override val committedStrategyId: StateFlow<String?> = MutableStateFlow(null)
    override val isBotActive: StateFlow<Boolean> = MutableStateFlow(false)
    override val isConnected: StateFlow<Boolean> = MutableStateFlow(false)

    override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?) = NetworkResult.Success(Unit)
    override suspend fun deactivateBot(): NetworkResult<Unit> {
        deactivateBotCalled = true
        if (deactivateDelayMs > 0) delay(deactivateDelayMs)
        deactivateBotException?.let { throw it }
        return NetworkResult.Success(Unit)
    }
    override suspend fun getStatus() = NetworkResult.Success(com.cryptopulse.app.domain.models.BotStatus(state = com.cryptopulse.app.domain.models.BotState.STOPPED, isActive = false))
    override suspend fun executeTrade(alertId: String) = NetworkResult.Success(com.cryptopulse.app.domain.models.TradeExecutionResult(
        positionId = "pos_1", alertId = alertId, orderId = "ord_1", symbol = "BTC/USDT", side = "BUY", strategy = "Scalper", exchange = "bybit", environment = "demo", orderType = "MARKET", status = "FILLED", entryStatus = "FILLED", requestedEntryPrice = 100.0, actualFillPrice = 100.0, requestedQuantity = 1.0, actualFilledQuantity = 1.0, remainingQuantity = 0.0, stopLoss = 95.0, takeProfit = 110.0, slippagePercent = 0.0, submittedAt = "now", executedAt = "now", isFilled = true
    ))
    override suspend fun executeMockTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto) = NetworkResult.Success(com.cryptopulse.app.domain.models.TradeExecutionResult(
        positionId = "pos_1", alertId = request.alertId ?: "1", orderId = "ord_1", symbol = "BTC/USDT", side = "BUY", strategy = "Scalper", exchange = "bybit", environment = "demo", orderType = "MARKET", status = "FILLED", entryStatus = "FILLED", requestedEntryPrice = 100.0, actualFillPrice = 100.0, requestedQuantity = 1.0, actualFilledQuantity = 1.0, remainingQuantity = 0.0, stopLoss = 95.0, takeProfit = 110.0, slippagePercent = 0.0, submittedAt = "now", executedAt = "now", isFilled = true
    ))
    override suspend fun getExecutionStatus(positionId: String) = NetworkResult.Success(com.cryptopulse.app.domain.models.TradeExecutionResult(
        positionId = positionId, alertId = "1", orderId = "ord_1", symbol = "BTC/USDT", side = "BUY", strategy = "Scalper", exchange = "bybit", environment = "demo", orderType = "MARKET", status = "FILLED", entryStatus = "FILLED", requestedEntryPrice = 100.0, actualFillPrice = 100.0, requestedQuantity = 1.0, actualFilledQuantity = 1.0, remainingQuantity = 0.0, stopLoss = 95.0, takeProfit = 110.0, slippagePercent = 0.0, submittedAt = "now", executedAt = "now", isFilled = true
    ))
    override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long) = kotlinx.coroutines.flow.flowOf(com.cryptopulse.app.domain.models.TradeExecutionResult(
        positionId = positionId, alertId = "1", orderId = "ord_1", symbol = "BTC/USDT", side = "BUY", strategy = "Scalper", exchange = "bybit", environment = "demo", orderType = "MARKET", status = "FILLED", entryStatus = "FILLED", requestedEntryPrice = 100.0, actualFillPrice = 100.0, requestedQuantity = 1.0, actualFilledQuantity = 1.0, remainingQuantity = 0.0, stopLoss = 95.0, takeProfit = 110.0, slippagePercent = 0.0, submittedAt = "now", executedAt = "now", isFilled = true
    ))
    override suspend fun stopTrade() = NetworkResult.Success(Unit)
    override suspend fun getAlerts() = NetworkResult.Success(emptyList<com.cryptopulse.app.domain.models.BotAlert>())
    override suspend fun acknowledgeAlert(alertId: String) = NetworkResult.Success(Unit)
    override suspend fun triggerAlert(symbol: String, strategy: String, config: TradeSetupConfig?) = NetworkResult.Success(com.cryptopulse.app.domain.models.BotAlert(id = "1", symbol = "BTC/USDT", entryPrice = 100.0, stopLoss = 95.0, takeProfit = 110.0, estimatedPnl = 50.0, strategy = "Scalper", side = "BUY", timestamp = "now"))
    override fun updateAnalysisState(snapshot: com.cryptopulse.app.domain.models.AnalysisSnapshot?) {}
    override fun updateConnectionState(connected: Boolean) {}
    override fun startObserving() { isObserving = true }
    override fun stopObserving() {
        stopObservingCalled = true
        isObserving = false
        stopObservingCount.incrementAndGet()
    }
}

private class FakeTradeSessionRepoForSession : TradeSessionRepository {
    var hasSession = true
    var clearSessionCalled = false
    var shouldThrow = false

    override val selectedStrategyId: StateFlow<String?> = MutableStateFlow(null)
    override val tradeSetupConfig: StateFlow<TradeSetupConfig?> = MutableStateFlow(null)

    override fun setStrategyId(id: String) {}
    override fun setTradeSetupConfig(config: TradeSetupConfig) {}
    override fun clearSession() {
        if (shouldThrow) throw RuntimeException("Simulated error clearing trade session")
        clearSessionCalled = true
        hasSession = false
    }
}

private class FakeExchangeConnectionManagerForSession : ExchangeConnectionManager(FakeContextForSession()) {
    var hasConnection = true
    var clearConnectionCalled = false
    var shouldThrow = false

    override val isConnected: kotlinx.coroutines.flow.Flow<Boolean> = kotlinx.coroutines.flow.flowOf(true)
    override val exchangeName: kotlinx.coroutines.flow.Flow<String?> = kotlinx.coroutines.flow.flowOf("bybit")
    override val exchangeEnvironment: kotlinx.coroutines.flow.Flow<String?> = kotlinx.coroutines.flow.flowOf("demo")

    override suspend fun saveConnection(exchangeName: String, environment: String) {}
    override suspend fun getConnectionInfo(): Triple<Boolean, String?, String?> = Triple(true, "bybit", "demo")
    override suspend fun clearConnection() {
        if (shouldThrow) throw RuntimeException("Simulated error clearing exchange connection")
        clearConnectionCalled = true
        hasConnection = false
    }
}

private class FakeStrategyRepoForSession : StrategyRepository {
    var hasCache = true
    var clearCacheCalled = false
    var shouldThrow = false

    override suspend fun getStrategies(): NetworkResult<List<Strategy>> = NetworkResult.Success(emptyList())
    override suspend fun getStrategyById(id: String): NetworkResult<Strategy?> = NetworkResult.Success(null)
    override fun clearCache() {
        if (shouldThrow) throw RuntimeException("Simulated error clearing strategy cache")
        clearCacheCalled = true
        hasCache = false
    }
}

private class FakeTokenManagerForSession : TokenManager(FakeContextForSession()) {
    var hasTokens = true
    var clearTokensCalled = false
    var throwException: Exception? = null

    override suspend fun clearTokens() {
        throwException?.let { throw it }
        clearTokensCalled = true
        hasTokens = false
    }
}

private class FakeFcmRepoForSession : FcmRepository {
    var clearRegistrationStateCalled = false
    var shouldThrow = false

    override suspend fun registerToken(token: String): NetworkResult<Unit> = NetworkResult.Success(Unit)

    override fun clearRegistrationState() {
        if (shouldThrow) throw RuntimeException("Simulated error clearing FCM registration")
        clearRegistrationStateCalled = true
    }
}

private class FakeContextForSession : android.content.ContextWrapper(null) {
    override fun getApplicationContext(): android.content.Context = this
}
