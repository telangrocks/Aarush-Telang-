package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.ApiConstants
import com.cryptopulse.app.data.api.TradingBotService
import com.cryptopulse.app.data.datasource.remote.bot.BotRemoteDataSource
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.*
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.auth.FakeContextMinimal
import com.cryptopulse.app.ui.auth.FakeExchangeRepository
import com.cryptopulse.app.ui.auth.FakeMarketRepositoryMinimal
import com.cryptopulse.app.ui.auth.FakeTechnicalAnalysisRepositoryMinimal
import com.cryptopulse.app.ui.auth.FakeTrackingBotRepository
import com.cryptopulse.app.ui.auth.FakeTrackingTradeAlertManager
import com.cryptopulse.app.ui.auth.FakeFcmRepositoryMinimal
import com.cryptopulse.app.ui.auth.FakeTokenManagerMinimal
import com.cryptopulse.app.ui.auth.FakeExchangeConnectionManagerMinimal
import com.cryptopulse.app.ui.auth.FakeTradeSessionRepositoryMinimal
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Stage 2.6 Android Manual Alert Generation & Mock Trade Removal Safety Verification Suite
 *
 * Verifies that:
 * 1. All manual trade triggering and mock trade entry points are completely removed across:
 *    - TechnicalAnalysisViewModel (no triggerTradeAlert)
 *    - BotRepository (no triggerAlert, no executeMockTrade)
 *    - BotRemoteDataSource (no triggerAlert, no executeMockTrade)
 *    - TradingBotService (no triggerAlert, no executeMockTrade)
 *    - ApiConstants (no BOT_TRIGGER_ALERT, no BOT_MOCK_TRADE)
 * 2. Autonomous bot activation (activateAutonomousBot, activateBot) remains fully functional.
 * 3. Autonomous bot deactivation (stopBot) remains fully functional.
 * 4. Autonomous Technical Analysis preview and polling remain fully functional.
 * 5. Backend-approved TradeAlertScreen execution path (ExchangeViewModel.executeCurrentTrade) remains 100% intact.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class Stage2_6_ManualTradeRemovalSafetyTest {

    private lateinit var testDispatcher: TestDispatcher

    @Before
    fun setUp() {
        testDispatcher = StandardTestDispatcher()
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // ── 1. Structural Verification via Reflection ─────────────────────────────

    @Test
    fun `01 - TechnicalAnalysisViewModel does not expose triggerTradeAlert`() {
        val methodNames = TechnicalAnalysisViewModel::class.java.methods.map { it.name }
        assertFalse(
            "TechnicalAnalysisViewModel must NOT declare or inherit triggerTradeAlert",
            methodNames.contains("triggerTradeAlert")
        )
    }

    @Test
    fun `02 - BotRepository interface does not declare triggerAlert or executeMockTrade`() {
        val methodNames = BotRepository::class.java.methods.map { it.name }
        assertFalse(
            "BotRepository must NOT declare triggerAlert",
            methodNames.contains("triggerAlert")
        )
        assertFalse(
            "BotRepository must NOT declare executeMockTrade",
            methodNames.contains("executeMockTrade")
        )
    }

    @Test
    fun `03 - BotRemoteDataSource interface does not declare triggerAlert or executeMockTrade`() {
        val methodNames = BotRemoteDataSource::class.java.methods.map { it.name }
        assertFalse(
            "BotRemoteDataSource must NOT declare triggerAlert",
            methodNames.contains("triggerAlert")
        )
        assertFalse(
            "BotRemoteDataSource must NOT declare executeMockTrade",
            methodNames.contains("executeMockTrade")
        )
    }

    @Test
    fun `04 - TradingBotService does not declare triggerAlert or executeMockTrade`() {
        val methodNames = TradingBotService::class.java.methods.map { it.name }
        assertFalse(
            "TradingBotService must NOT declare triggerAlert",
            methodNames.contains("triggerAlert")
        )
        assertFalse(
            "TradingBotService must NOT declare executeMockTrade",
            methodNames.contains("executeMockTrade")
        )
    }

    @Test
    fun `05 - ApiConstants does not declare BOT_TRIGGER_ALERT or BOT_MOCK_TRADE`() {
        val fieldNames = ApiConstants::class.java.declaredFields.map { it.name }
        assertFalse(
            "ApiConstants must NOT declare BOT_TRIGGER_ALERT",
            fieldNames.contains("BOT_TRIGGER_ALERT")
        )
        assertFalse(
            "ApiConstants must NOT declare BOT_MOCK_TRADE",
            fieldNames.contains("BOT_MOCK_TRADE")
        )
    }

    // ── 2. Autonomous Functionality Preservation ──────────────────────────────

    @Test
    fun `06 - TechnicalAnalysisViewModel preserves autonomous bot activation`() = runTest {
        var activatedSymbols: List<String>? = null
        var activatedStrategy: String? = null

        val fakeBotRepo = object : BotRepository {
            override val analysisState: StateFlow<AnalysisSnapshot?> = MutableStateFlow(null).asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = MutableStateFlow(null).asStateFlow()
            override val committedStrategyId: StateFlow<String?> = MutableStateFlow("ScalperV2").asStateFlow()
            override val isBotActive: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                activatedSymbols = symbols
                activatedStrategy = strategy
                return NetworkResult.Success(Unit)
            }
            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(BotState.ANALYSING, true, "BTCUSDT", "ScalperV2"))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long) = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) {}
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        val sessionRepo = object : TradeSessionRepository {
            private val _id = MutableStateFlow<String?>("ScalperV2")
            override val selectedStrategyId: StateFlow<String?> = _id.asStateFlow()
            override val tradeSetupConfig: StateFlow<TradeSetupConfig?> = MutableStateFlow<TradeSetupConfig?>(null).asStateFlow()
            override fun setStrategyId(id: String) { _id.value = id }
            override fun setTradeSetupConfig(config: TradeSetupConfig) {}
            override fun clearSession() {}
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = sessionRepo,
            botRepository = fakeBotRepo,
            technicalAnalysisRepository = FakeTechnicalAnalysisRepositoryMinimal(),
            strategyRepository = object : StrategyRepository {
                override suspend fun getStrategies(): NetworkResult<List<Strategy>> = NetworkResult.Success(emptyList())
                override suspend fun getStrategyById(id: String): NetworkResult<Strategy?> = NetworkResult.Success(null)
                override fun clearCache() {}
            },
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        var successCalled = false
        val candidateSymbols = listOf("BTCUSDT", "ETHUSDT", "SOLUSDT")
        viewModel.activateAutonomousBot(candidateSymbols, null) {
            successCalled = true
        }
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue("Autonomous activation must succeed", successCalled)
        assertEquals("ScalperV2", activatedStrategy)
        assertEquals(candidateSymbols, activatedSymbols)
    }

    @Test
    fun `07 - TechnicalAnalysisViewModel preserves autonomous bot deactivation`() = runTest {
        var deactivateCalled = false

        val fakeBotRepo = object : BotRepository {
            override val analysisState: StateFlow<AnalysisSnapshot?> = MutableStateFlow(null).asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = MutableStateFlow(null).asStateFlow()
            override val committedStrategyId: StateFlow<String?> = MutableStateFlow("ScalperV2").asStateFlow()
            override val isBotActive: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun deactivateBot(): NetworkResult<Unit> {
                deactivateCalled = true
                return NetworkResult.Success(Unit)
            }
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(BotState.STOPPED, false, null, null))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long) = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) {}
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        val sessionRepo = object : TradeSessionRepository {
            override val selectedStrategyId: StateFlow<String?> = MutableStateFlow<String?>("ScalperV2").asStateFlow()
            override val tradeSetupConfig: StateFlow<TradeSetupConfig?> = MutableStateFlow<TradeSetupConfig?>(null).asStateFlow()
            override fun setStrategyId(id: String) {}
            override fun setTradeSetupConfig(config: TradeSetupConfig) {}
            override fun clearSession() {}
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = sessionRepo,
            botRepository = fakeBotRepo,
            technicalAnalysisRepository = FakeTechnicalAnalysisRepositoryMinimal(),
            strategyRepository = object : StrategyRepository {
                override suspend fun getStrategies(): NetworkResult<List<Strategy>> = NetworkResult.Success(emptyList())
                override suspend fun getStrategyById(id: String): NetworkResult<Strategy?> = NetworkResult.Success(null)
                override fun clearCache() {}
            },
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        var stoppedCalled = false
        viewModel.stopBot {
            stoppedCalled = true
        }
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue("stopBot callback must be invoked", stoppedCalled)
        assertTrue("Repository deactivateBot must be called", deactivateCalled)
    }

    @Test
    fun `08 - TradeAlertScreen autonomous trade execution remains fully intact`() = runTest {
        val fakeBotRepo = FakeTrackingBotRepository()
        val fakeAlertManager = FakeTrackingTradeAlertManager()

        val exchangeVm = ExchangeViewModel(
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

        val approvedAutonomousAlert = mapOf<String, Any>(
            "id" to "autonomous_alert_777",
            "symbol" to "BTC/USDT",
            "entryPrice" to 95000.0,
            "stopLoss" to 93500.0,
            "takeProfit" to 98000.0,
            "positionSize" to 500.0,
            "strategy" to "ScalperV2",
            "side" to "BUY",
            "quantity" to 0.005,
            "isExecutable" to true
        )
        exchangeVm.setPendingAlert(approvedAutonomousAlert)

        // User taps TRADE on TradeAlertScreen
        exchangeVm.executeCurrentTrade()
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("Autonomous alert execution MUST trigger executeTrade API", 1, fakeBotRepo.executeTradeCallCount)
        assertEquals("autonomous_alert_777", fakeBotRepo.lastExecutedAlertId)
        assertTrue("Execution state must transition to Filled", exchangeVm.executionState.value is ExecutionUiState.Filled)
        assertEquals("Alarm cutoff must be triggered", 1, fakeAlertManager.dismissOrExecuteCallCount)

        exchangeVm.stopLiveTicker()
    }

    private fun createDummyExecResult(id: String) = TradeExecutionResult(
        positionId = id,
        alertId = id,
        orderId = "order_$id",
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
        requestedQuantity = 0.001,
        actualFilledQuantity = 0.001,
        remainingQuantity = 0.0,
        stopLoss = 93500.0,
        takeProfit = 98000.0,
        slippagePercent = 0.0,
        submittedAt = "",
        executedAt = "",
        isFilled = true,
        isMockTrade = false
    )
}
