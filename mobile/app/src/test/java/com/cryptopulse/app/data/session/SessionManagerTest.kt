package com.cryptopulse.app.data.session

import android.content.Context
import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.domain.repository.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

@OptIn(ExperimentalCoroutinesApi::class)
class SessionManagerTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var dispatcherProvider: DispatcherProvider
    private lateinit var fakeAuthRepo: FakeAuthRepoForSession
    private lateinit var fakeBotRepo: FakeBotRepoForSession
    private lateinit var fakeTradeSessionRepo: FakeTradeSessionRepoForSession
    private lateinit var fakeExchangeConnectionManager: FakeExchangeConnectionManagerForSession
    private lateinit var fakeStrategyRepo: FakeStrategyRepoForSession
    private lateinit var fakeTokenManager: FakeTokenManagerForSession
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

        sessionManager = SessionManager(
            authRepository = fakeAuthRepo,
            botRepository = fakeBotRepo,
            tradeSessionRepository = fakeTradeSessionRepo,
            exchangeConnectionManager = fakeExchangeConnectionManager,
            strategyRepository = fakeStrategyRepo,
            tokenManager = fakeTokenManager,
            dispatcherProvider = dispatcherProvider
        )
    }

    @Test
    fun `performLogout halts polling, clears caches, clears trade session, notifies backend, and wipes tokens`() = runTest {
        fakeBotRepo.isObserving = true
        fakeTokenManager.hasTokens = true
        fakeTradeSessionRepo.hasSession = true
        fakeStrategyRepo.hasCache = true
        fakeExchangeConnectionManager.hasConnection = true

        sessionManager.performLogout(FakeContextForSession())

        assertTrue("Bot observation must be stopped", fakeBotRepo.stopObservingCalled)
        assertTrue("Trade session must be cleared", fakeTradeSessionRepo.clearSessionCalled)
        assertTrue("Strategy cache must be cleared", fakeStrategyRepo.clearCacheCalled)
        assertTrue("Exchange credentials must be cleared", fakeExchangeConnectionManager.clearConnectionCalled)
        assertTrue("Backend logout must be invoked", fakeAuthRepo.logoutCalled)
        assertTrue("Tokens must be wiped", fakeTokenManager.clearTokensCalled)
    }

    @Test
    fun `concurrent performLogout calls execute safely and idempotently`() = runTest {
        coroutineScope {
            repeat(5) {
                launch(Dispatchers.IO) {
                    sessionManager.performLogout(FakeContextForSession())
                }
            }
        }

        assertEquals(1, fakeAuthRepo.logoutCount.get())
        assertEquals(1, fakeBotRepo.stopObservingCount.get())
    }
}

private class FakeAuthRepoForSession : AuthRepository {
    var logoutCalled = false
    val logoutCount = AtomicInteger(0)

    override suspend fun login(email: String, password: String) = NetworkResult.Success(Unit)
    override suspend fun register(email: String, password: String, confirm: String) = NetworkResult.Success(Unit)
    override suspend fun logout(): NetworkResult<Unit> {
        logoutCalled = true
        logoutCount.incrementAndGet()
        return NetworkResult.Success(Unit)
    }
    override suspend fun refreshToken() = NetworkResult.Success(Unit)
}

private class FakeBotRepoForSession : BotRepository {
    var isObserving = false
    var stopObservingCalled = false
    val stopObservingCount = AtomicInteger(0)

    override val analysisState: StateFlow<com.cryptopulse.app.domain.models.AnalysisSnapshot?> = MutableStateFlow(null)
    override val activeBotAnalysisState: StateFlow<com.cryptopulse.app.domain.models.AnalysisSnapshot?> = MutableStateFlow(null)
    override val committedStrategyId: StateFlow<String?> = MutableStateFlow(null)
    override val isBotActive: StateFlow<Boolean> = MutableStateFlow(false)
    override val isConnected: StateFlow<Boolean> = MutableStateFlow(false)

    override suspend fun activateBot(symbol: String, strategy: String, config: TradeSetupConfig?) = NetworkResult.Success(Unit)
    override suspend fun deactivateBot() = NetworkResult.Success(Unit)
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

    override val selectedStrategyId: StateFlow<String?> = MutableStateFlow(null)
    override val tradeSetupConfig: StateFlow<TradeSetupConfig?> = MutableStateFlow(null)

    override fun setStrategyId(id: String) {}
    override fun setTradeSetupConfig(config: TradeSetupConfig) {}
    override fun clearSession() {
        clearSessionCalled = true
        hasSession = false
    }
}

private class FakeExchangeConnectionManagerForSession : ExchangeConnectionManager(FakeContextForSession()) {
    var hasConnection = true
    var clearConnectionCalled = false

    override val isConnected: kotlinx.coroutines.flow.Flow<Boolean> = kotlinx.coroutines.flow.flowOf(true)
    override val exchangeName: kotlinx.coroutines.flow.Flow<String?> = kotlinx.coroutines.flow.flowOf("bybit")
    override val exchangeEnvironment: kotlinx.coroutines.flow.Flow<String?> = kotlinx.coroutines.flow.flowOf("demo")

    override suspend fun saveConnection(exchangeName: String, environment: String) {}
    override suspend fun getConnectionInfo(): Triple<Boolean, String?, String?> = Triple(true, "bybit", "demo")
    override suspend fun clearConnection() {
        clearConnectionCalled = true
        hasConnection = false
    }
}

private class FakeStrategyRepoForSession : StrategyRepository {
    var hasCache = true
    var clearCacheCalled = false

    override suspend fun getStrategies(): NetworkResult<List<Strategy>> = NetworkResult.Success(emptyList())
    override suspend fun getStrategyById(id: String): NetworkResult<Strategy?> = NetworkResult.Success(null)
    override fun clearCache() {
        clearCacheCalled = true
        hasCache = false
    }
}

private class FakeTokenManagerForSession : TokenManager(FakeContextForSession()) {
    var hasTokens = true
    var clearTokensCalled = false

    override suspend fun clearTokens() {
        clearTokensCalled = true
        hasTokens = false
    }
}

private class FakeContextForSession : android.content.ContextWrapper(null) {
    override fun getApplicationContext(): android.content.Context = this
}
