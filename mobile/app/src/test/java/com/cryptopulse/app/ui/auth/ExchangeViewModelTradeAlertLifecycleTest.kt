package com.cryptopulse.app.ui.auth

import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.ExecutionUiState
import com.cryptopulse.app.domain.models.TradeExecutionResult
import com.cryptopulse.app.service.TradeAlertState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ExchangeViewModelTradeAlertLifecycleTest {

    private lateinit var viewModel: ExchangeViewModel
    private lateinit var fakeBotRepo: FakeTrackingBotRepository
    private lateinit var fakeAlertManager: FakeTrackingTradeAlertManager
    private lateinit var testDispatcher: kotlinx.coroutines.test.TestDispatcher

    @Before
    fun setup() {
        testDispatcher = UnconfinedTestDispatcher()
        Dispatchers.setMain(testDispatcher)
        fakeBotRepo = FakeTrackingBotRepository()
        fakeAlertManager = FakeTrackingTradeAlertManager()

        viewModel = ExchangeViewModel(
            appContext = FakeContextMinimal(),
            exchangeRepository = FakeExchangeRepository(),
            marketRepository = FakeMarketRepositoryMinimal(),
            technicalAnalysisRepository = FakeTechnicalAnalysisRepositoryMinimal(),
            botRepository = fakeBotRepo,
            fcmRepository = FakeFcmRepositoryMinimal(),
            tokenManager = FakeTokenManagerMinimal(),
            exchangeConnectionManager = FakeExchangeConnectionManagerMinimal(),
            sessionRepository = FakeTradeSessionRepositoryMinimal(),
            tradeAlertManager = fakeAlertManager
        )
    }

    @After
    fun tearDown() {
        viewModel.stopLiveTicker()
        Dispatchers.resetMain()
    }

    @Test
    fun `executeCurrentTrade should immediately call dismissOrExecuteAlert and stop alarm`() {
        val alertData = mapOf<String, Any>(
            "id" to "alert_12345",
            "symbol" to "BTC/USDT",
            "entryPrice" to 95000.0,
            "stopLoss" to 93500.0,
            "takeProfit" to 98000.0,
            "positionSize" to 500.0,
            "strategy" to "ScalperV2",
            "side" to "BUY",
            "quantity" to 0.005
        )
        viewModel.setPendingAlert(alertData)

        assertEquals(0, fakeAlertManager.dismissOrExecuteCallCount)

        viewModel.executeCurrentTrade()

        // Verify alarm cutoff occurred immediately
        assertEquals(1, fakeAlertManager.dismissOrExecuteCallCount)
        assertEquals("alert_12345", fakeBotRepo.lastExecutedAlertId)
        assertTrue(viewModel.executionState.value is ExecutionUiState.Filled)
    }

    @Test
    fun `executeCurrentTrade should prevent duplicate button presses while in flight`() = kotlinx.coroutines.test.runTest {
        val alertData = mapOf<String, Any>(
            "id" to "alert_double_tap",
            "symbol" to "BTC/USDT",
            "entryPrice" to 95000.0,
            "stopLoss" to 93500.0,
            "takeProfit" to 98000.0,
            "positionSize" to 500.0,
            "strategy" to "ScalperV2",
            "side" to "BUY",
            "quantity" to 0.005
        )
        viewModel.setPendingAlert(alertData)

        // Enable suspension so executeTrade stays in flight
        fakeBotRepo.suspendExecution = true

        // First click - transitions to Submitting and suspends in repository
        viewModel.executeCurrentTrade()
        assertTrue(viewModel.executionState.value is ExecutionUiState.Submitting)
        assertEquals(1, fakeBotRepo.executeTradeCallCount)
        assertEquals(1, fakeAlertManager.dismissOrExecuteCallCount)

        // Rapid second click while first is in flight
        viewModel.executeCurrentTrade()

        // Call count should NOT increase and alert dismiss should NOT be called again
        assertEquals(1, fakeBotRepo.executeTradeCallCount)
        assertEquals(1, fakeAlertManager.dismissOrExecuteCallCount)

        // Complete the in-flight execution
        fakeBotRepo.completeSuspendedExecution()
        assertTrue(viewModel.executionState.value is ExecutionUiState.Filled)
    }

    @Test
    fun `executeCurrentTrade preserves trade parameters when execution fails and alarm remains stopped`() {
        fakeBotRepo.executionShouldFail = true
        val alertData = mapOf<String, Any>(
            "id" to "alert_fail_test",
            "symbol" to "ETH/USDT",
            "entryPrice" to 3500.0,
            "stopLoss" to 3400.0,
            "takeProfit" to 3700.0,
            "positionSize" to 200.0,
            "strategy" to "Momentum",
            "side" to "BUY",
            "quantity" to 0.057
        )
        viewModel.setPendingAlert(alertData)

        viewModel.executeCurrentTrade()

        // Alarm was stopped immediately
        assertEquals(1, fakeAlertManager.dismissOrExecuteCallCount)
        // Error state reached
        assertTrue(viewModel.executionState.value is ExecutionUiState.Failed)
        assertNotNull(viewModel.tradeError.value)
        // Alarm is still stopped (no reactivation)
        assertEquals(1, fakeAlertManager.dismissOrExecuteCallCount)
    }

    @Test
    fun `lifecycle test - state preserved and alarm remains stopped across simulated activity recreation`() {
        val alertData = mapOf<String, Any>(
            "id" to "alert_lifecycle_test",
            "symbol" to "SOL/USDT",
            "entryPrice" to 150.0,
            "stopLoss" to 145.0,
            "takeProfit" to 160.0,
            "positionSize" to 300.0,
            "strategy" to "Breakout",
            "side" to "BUY",
            "quantity" to 2.0
        )
        viewModel.setPendingAlert(alertData)

        // 1. User presses Trade
        viewModel.executeCurrentTrade()

        // 2. Alarm stopped
        assertEquals(1, fakeAlertManager.dismissOrExecuteCallCount)
        assertTrue(viewModel.executionState.value is ExecutionUiState.Filled)

        // 3. Simulate Activity recreation: new observer attaches to StateFlows
        val currentExecutionState = viewModel.executionState.value
        val lastTrade = viewModel.lastTrade.value

        assertNotNull(currentExecutionState)
        assertTrue(currentExecutionState is ExecutionUiState.Filled)
        assertNotNull(lastTrade)
        assertEquals(95000.0, lastTrade?.entryPrice ?: 0.0, 0.001)

        // 4. Verify alarm manager was not re-triggered
        assertEquals(1, fakeAlertManager.dismissOrExecuteCallCount)
    }

    @Test
    fun `executeCurrentTrade fails closed when quantity is missing or invalid`() {
        val alertData = mapOf<String, Any>(
            "id" to "alert_missing_qty",
            "symbol" to "SOL/USDT",
            "entryPrice" to 150.0,
            "side" to "BUY"
            // No quantity provided
        )
        viewModel.setPendingAlert(alertData)

        viewModel.executeCurrentTrade()

        assertTrue(viewModel.executionState.value is ExecutionUiState.Failed)
        assertEquals("Missing or invalid approved quantity. Cannot execute trade.", viewModel.tradeError.value)
        assertEquals(0, fakeBotRepo.executeTradeCallCount)
        assertEquals(0, fakeAlertManager.dismissOrExecuteCallCount)
    }

    @Test
    fun `dismissCurrentAlert should invoke dismissAlert on botRepository and coordinate completion`() {
        val alertData = mapOf<String, Any>(
            "id" to "alert_dismiss_test",
            "symbol" to "BTC/USDT",
            "entryPrice" to 95000.0,
            "quantity" to 0.005
        )
        viewModel.setPendingAlert(alertData)

        var navigationInvoked = false
        viewModel.dismissCurrentAlert {
            navigationInvoked = true
        }

        assertEquals(1, fakeBotRepo.dismissAlertCallCount)
        assertEquals("alert_dismiss_test", fakeBotRepo.lastDismissedAlertId)
        assertEquals(1, fakeAlertManager.dismissOrExecuteCallCount)
        assertNull(viewModel.pendingAlert.value)
        assertFalse(viewModel.isDismissingAlert.value)
        assertTrue(navigationInvoked)
    }

    @Test
    fun `dismissCurrentAlert should track isDismissingAlert and prevent concurrent trade execution`() = kotlinx.coroutines.test.runTest {
        val alertData = mapOf<String, Any>(
            "id" to "alert_dismiss_race",
            "symbol" to "BTC/USDT",
            "entryPrice" to 95000.0,
            "quantity" to 0.005
        )
        viewModel.setPendingAlert(alertData)

        // Suspend dismissal so it stays in-flight
        fakeBotRepo.suspendDismissal = true

        var navigationInvoked = false
        viewModel.dismissCurrentAlert {
            navigationInvoked = true
        }

        // Verify dismissal is active and guarding
        assertTrue(viewModel.isDismissingAlert.value)
        assertFalse(navigationInvoked)

        // Attempt concurrent trade execution while dismissing
        viewModel.executeCurrentTrade()
        assertEquals(0, fakeBotRepo.executeTradeCallCount)

        // Attempt concurrent duplicate dismissal
        viewModel.dismissCurrentAlert { }
        assertEquals(1, fakeBotRepo.dismissAlertCallCount)

        // Complete the suspended dismissal
        fakeBotRepo.completeSuspendedDismissal(true)

        assertFalse(viewModel.isDismissingAlert.value)
        assertNull(viewModel.pendingAlert.value)
        assertTrue(navigationInvoked)
    }

    @Test
    fun `dismissCurrentAlert on network failure retains pending alert, shows error message, and does not navigate`() {
        val alertData = mapOf<String, Any>(
            "id" to "alert_fail_network",
            "symbol" to "BTC/USDT",
            "entryPrice" to 95000.0,
            "quantity" to 0.005
        )
        viewModel.setPendingAlert(alertData)

        // Simulate network timeout failure
        fakeBotRepo.dismissalResult = NetworkResult.Error(NetworkError.Timeout)

        var navigationInvoked = false
        viewModel.dismissCurrentAlert {
            navigationInvoked = true
        }

        // Must NOT navigate and must retain pending alert
        assertFalse(navigationInvoked)
        assertNotNull(viewModel.pendingAlert.value)
        assertEquals("alert_fail_network", viewModel.pendingAlert.value?.get("id"))
        assertFalse(viewModel.isDismissingAlert.value)
        assertEquals(1, fakeBotRepo.dismissAlertCallCount)
        assertEquals(0, fakeAlertManager.dismissOrExecuteCallCount)

        // Verify clear error message is surfaced to user
        assertNotNull(viewModel.tradeError.value)
        assertTrue(viewModel.tradeError.value?.contains("timeout", ignoreCase = true) == true)

        // Verify retry capability
        fakeBotRepo.dismissalResult = NetworkResult.Success(Unit)
        viewModel.clearTradeError()
        viewModel.dismissCurrentAlert {
            navigationInvoked = true
        }

        assertEquals(2, fakeBotRepo.dismissAlertCallCount)
        assertTrue(navigationInvoked)
        assertNull(viewModel.pendingAlert.value)
        assertEquals(1, fakeAlertManager.dismissOrExecuteCallCount)
    }

    @Test
    fun `dismissCurrentAlert on HTTP 409 explains execution started, retains alert, and blocks navigation`() {
        val alertData = mapOf<String, Any>(
            "id" to "alert_fail_409",
            "symbol" to "BTC/USDT",
            "entryPrice" to 95000.0,
            "quantity" to 0.005
        )
        viewModel.setPendingAlert(alertData)

        // Simulate HTTP 409 conflict (execution in progress)
        fakeBotRepo.dismissalResult = NetworkResult.Error(NetworkError.HttpError(409, "Conflict"))

        var navigationInvoked = false
        viewModel.dismissCurrentAlert {
            navigationInvoked = true
        }

        // Must NOT navigate and must retain pending alert
        assertFalse(navigationInvoked)
        assertNotNull(viewModel.pendingAlert.value)
        assertEquals("alert_fail_409", viewModel.pendingAlert.value?.get("id"))

        // Error message must explain execution has already started and dismissal is not allowed
        assertNotNull(viewModel.tradeError.value)
        assertTrue(viewModel.tradeError.value?.contains("execution has already started", ignoreCase = true) == true)
    }

    @Test
    fun `dismissCurrentAlert on HTTP 500 or 404 retains alert and displays error message`() {
        val alertData = mapOf<String, Any>(
            "id" to "alert_fail_500",
            "symbol" to "BTC/USDT",
            "entryPrice" to 95000.0,
            "quantity" to 0.005
        )
        viewModel.setPendingAlert(alertData)

        // Simulate HTTP 500 server error
        fakeBotRepo.dismissalResult = NetworkResult.Error(NetworkError.HttpError(500, "Internal Server Error"))

        var navigationInvoked = false
        viewModel.dismissCurrentAlert {
            navigationInvoked = true
        }

        // Must NOT navigate and must retain pending alert
        assertFalse(navigationInvoked)
        assertNotNull(viewModel.pendingAlert.value)
        assertNotNull(viewModel.tradeError.value)
        assertTrue(viewModel.tradeError.value?.contains("500") == true)
    }
}


// ── Tracking Fakes ────────────────────────────────────────────────────────────

class FakeTrackingTradeAlertManager : com.cryptopulse.app.service.TradeAlertManager() {
    var dismissOrExecuteCallCount = 0
    var lastReceivedAlert: Map<String, Any>? = null

    override fun onNewAlertReceived(alert: Map<String, Any>) {
        lastReceivedAlert = alert
    }

    override fun dismissOrExecuteAlert() {
        dismissOrExecuteCallCount++
    }
}

class FakeTrackingBotRepository : com.cryptopulse.app.domain.repository.BotRepository {
    var executeTradeCallCount = 0
    var lastExecutedAlertId: String? = null
    var executionShouldFail = false
    var suspendExecution = false
    private var executionDeferred: kotlinx.coroutines.CompletableDeferred<NetworkResult<TradeExecutionResult>>? = null

    fun completeSuspendedExecution(success: Boolean = true) {
        val alertId = lastExecutedAlertId ?: "alert_default"
        val result = if (success) {
            NetworkResult.Success(
                TradeExecutionResult(
                    positionId = "pos_$alertId",
                    alertId = alertId,
                    orderId = "order_$alertId",
                    symbol = "BTC/USDT",
                    side = "BUY",
                    strategy = "ScalperV2",
                    exchange = "bybit",
                    environment = "mainnet",
                    orderType = "MARKET",
                    status = "OPEN",
                    entryStatus = "FILLED",
                    requestedEntryPrice = 95000.0,
                    actualFillPrice = 95000.0,
                    requestedQuantity = 0.005,
                    actualFilledQuantity = 0.005,
                    remainingQuantity = 0.0,
                    stopLoss = 93500.0,
                    takeProfit = 98000.0,
                    slippagePercent = 0.0,
                    submittedAt = "2026-09-02T05:00:00Z",
                    executedAt = "2026-09-02T05:00:01Z",
                    isFilled = true,
                    isMockTrade = false
                )
            )
        } else {
            NetworkResult.Error(NetworkError.HttpError(400, "Order rejected: Min notional not met"))
        }
        executionDeferred?.complete(result)
    }

    override val isConnected: kotlinx.coroutines.flow.StateFlow<Boolean> = MutableStateFlow(true)
    override val analysisState: kotlinx.coroutines.flow.StateFlow<com.cryptopulse.app.domain.models.AnalysisSnapshot?> = MutableStateFlow(null)
    override val activeBotAnalysisState: kotlinx.coroutines.flow.StateFlow<com.cryptopulse.app.domain.models.AnalysisSnapshot?> = MutableStateFlow(null)
    override val committedStrategyId: kotlinx.coroutines.flow.StateFlow<String?> = MutableStateFlow(null)
    override val isBotActive: kotlinx.coroutines.flow.StateFlow<Boolean> = MutableStateFlow(true)
    override fun startObserving() {}
    override fun stopObserving() {}
    override fun updateAnalysisState(snapshot: com.cryptopulse.app.domain.models.AnalysisSnapshot?) {}
    override fun updateConnectionState(connected: Boolean) {}
    override suspend fun activateBot(symbols: List<String>, strategy: String, config: com.cryptopulse.app.domain.models.TradeSetupConfig?): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun getStatus(): NetworkResult<com.cryptopulse.app.domain.models.BotStatus> = NetworkResult.Success(com.cryptopulse.app.domain.models.BotStatus(state = com.cryptopulse.app.domain.models.BotState.ANALYSING, isActive = true))

    override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> {
        executeTradeCallCount++
        lastExecutedAlertId = alertId

        if (suspendExecution) {
            val deferred = kotlinx.coroutines.CompletableDeferred<NetworkResult<TradeExecutionResult>>()
            executionDeferred = deferred
            return deferred.await()
        }

        return if (executionShouldFail) {
            NetworkResult.Error(NetworkError.HttpError(400, "Order rejected: Min notional not met"))
        } else {
            NetworkResult.Success(
                TradeExecutionResult(
                    positionId = "pos_$alertId",
                    alertId = alertId,
                    orderId = "order_$alertId",
                    symbol = "BTC/USDT",
                    side = "BUY",
                    strategy = "ScalperV2",
                    exchange = "bybit",
                    environment = "mainnet",
                    orderType = "MARKET",
                    status = "OPEN",
                    entryStatus = "FILLED",
                    requestedEntryPrice = 95000.0,
                    actualFillPrice = 95000.0,
                    requestedQuantity = 0.005,
                    actualFilledQuantity = 0.005,
                    remainingQuantity = 0.0,
                    stopLoss = 93500.0,
                    takeProfit = 98000.0,
                    slippagePercent = 0.0,
                    submittedAt = "2026-09-02T05:00:00Z",
                    executedAt = "2026-09-02T05:00:01Z",
                    isFilled = true,
                    isMockTrade = false
                )
            )
        }
    }

    override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = executeTrade(positionId)
    override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf()
    override suspend fun getAlerts(): NetworkResult<List<com.cryptopulse.app.domain.models.BotAlert>> = NetworkResult.Success(emptyList())
    override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)

    var dismissAlertCallCount = 0
    var lastDismissedAlertId: String? = null
    var suspendDismissal = false
    var dismissalResult: NetworkResult<Unit> = NetworkResult.Success(Unit)
    private var dismissalDeferred: kotlinx.coroutines.CompletableDeferred<NetworkResult<Unit>>? = null

    fun completeSuspendedDismissal(success: Boolean = true) {
        val result = if (success) {
            NetworkResult.Success(Unit)
        } else {
            NetworkResult.Error(NetworkError.HttpError(500, "Server error"))
        }
        dismissalDeferred?.complete(result)
    }

    override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> {
        dismissAlertCallCount++
        lastDismissedAlertId = alertId
        if (suspendDismissal) {
            val deferred = kotlinx.coroutines.CompletableDeferred<NetworkResult<Unit>>()
            dismissalDeferred = deferred
            return deferred.await()
        }
        return dismissalResult
    }
}
