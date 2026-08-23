package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.domain.repository.TechnicalAnalysisRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import com.cryptopulse.app.data.api.dto.technicalanalysis.response.TechnicalAnalysisResponseDto
import com.cryptopulse.app.data.mapper.technicalanalysis.toAnalysisSnapshot

@OptIn(ExperimentalCoroutinesApi::class)
class TechnicalAnalysisViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun createMockSessionRepository(strategyId: String?): TradeSessionRepository {
        return object : TradeSessionRepository {
            private val _id = MutableStateFlow(strategyId)
            override val selectedStrategyId: StateFlow<String?> = _id.asStateFlow()

            private val _config = MutableStateFlow<TradeSetupConfig?>(null)
            override val tradeSetupConfig: StateFlow<TradeSetupConfig?> = _config.asStateFlow()

            override fun setStrategyId(id: String) { _id.value = id }
            override fun setTradeSetupConfig(config: TradeSetupConfig) { _config.value = config }
            override fun clearSession() {}
        }
    }

    private fun createMockBotRepository(shouldSucceed: Boolean = true): BotRepository {
        return object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()

            private val _isConnected = MutableStateFlow(true)
            override val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

            override suspend fun activateBot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                return if (shouldSucceed) {
                    NetworkResult.Success(Unit)
                } else {
                    NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(400, "Failed", "ERROR"))
                }
            }

            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = "ScalperV2"))
            override suspend fun executeTrade(alertId: String): NetworkResult<com.cryptopulse.app.domain.models.TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun executeMockTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto): NetworkResult<com.cryptopulse.app.domain.models.TradeExecutionResult> = NetworkResult.Success(createDummyExecResult("mock"))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<com.cryptopulse.app.domain.models.TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<com.cryptopulse.app.domain.models.TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)

            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { _analysisState.value = snapshot }
            override fun updateConnectionState(connected: Boolean) { _isConnected.value = connected }
            override fun startObserving() {}
            override fun stopObserving() {}
        }
    }

    private fun createMockTechnicalAnalysisRepository(): TechnicalAnalysisRepository {
        return object : TechnicalAnalysisRepository {
            override suspend fun getAnalysis(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<TechnicalAnalysisResult> {
                return NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(400, "Mock", "MOCK"))
            }
            override suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<AnalysisSnapshot> {
                return NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(400, "Mock", "MOCK"))
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> uninitialized(): T = null as T

    @Test
    fun `activateBot performs explicit user activation handshake and invokes onSuccess`() = runTest {
        val viewModel = TechnicalAnalysisViewModel(
            createMockSessionRepository("scalper-v2"),
            createMockBotRepository(shouldSucceed = true),
            createMockTechnicalAnalysisRepository(),
            com.cryptopulse.app.service.TradeAlertManager()
        )

        var isSuccessInvoked = false
        viewModel.activateBot("BTC", "scalper-v2", null) {
            isSuccessInvoked = true
        }

        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(isSuccessInvoked)
    }

    @Test
    fun `stopBot deactivates session and invokes onSuccess`() = runTest {
        val viewModel = TechnicalAnalysisViewModel(
            createMockSessionRepository("scalper-v2"),
            createMockBotRepository(shouldSucceed = true),
            createMockTechnicalAnalysisRepository(),
            com.cryptopulse.app.service.TradeAlertManager()
        )

        var isStoppedInvoked = false
        viewModel.stopBot {
            isStoppedInvoked = true
        }

        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(isStoppedInvoked)
    }

    @Test
    fun `toAnalysisSnapshot correctly maps non-null opportunity field from response DTO to BotAlert`() {
        val responseDto = TechnicalAnalysisResponseDto(
            symbol = "BTCUSDT",
            strategy = "ScalperV2",
            price = 50000.0,
            change24h = 2.5,
            volume = 1000000.0,
            high24h = 51000.0,
            low24h = 49000.0,
            indicators = emptyMap(),
            signals = emptyMap(),
            checkpoints = emptyList(),
            progress = 85,
            conditionsMet = listOf("Trend Aligned"),
            opportunity = mapOf(
                "id" to "mock-alert-uuid-1234",
                "symbol" to "BTCUSDT",
                "entryPrice" to 50000.0,
                "stopLoss" to 49000.0,
                "takeProfit" to 52000.0,
                "estimatedPnl" to 4.0,
                "strategy" to "ScalperV2",
                "side" to "BUY",
                "timestamp" to "2026-08-22T12:00:00Z",
                "signalPrice" to 50000.0,
                "targetEntryPrice" to 50100.0,
                "positionSize" to 100.0
            ),
            timestamp = "2026-08-22T12:00:00Z"
        )

        val mappedSnapshot = responseDto.toAnalysisSnapshot()

        assertNotNull("Opportunity must not be null in mapped AnalysisSnapshot", mappedSnapshot.opportunity)
        val alert = mappedSnapshot.opportunity!!
        assertEquals("mock-alert-uuid-1234", alert.id)
        assertEquals("BTCUSDT", alert.symbol)
        assertEquals(50000.0, alert.entryPrice, 0.0001)
        assertEquals(49000.0, alert.stopLoss, 0.0001)
        assertEquals(52000.0, alert.takeProfit, 0.0001)
        assertEquals(4.0, alert.estimatedPnl, 0.0001)
        assertEquals("ScalperV2", alert.strategy)
        assertEquals("BUY", alert.side)
        assertEquals(50000.0, alert.signalPrice ?: 0.0, 0.0001)
        assertEquals(50100.0, alert.targetEntryPrice ?: 0.0, 0.0001)
        assertEquals(100.0, alert.positionSize ?: 0.0, 0.0001)
    }

    @Test
    fun `triggerTradeAlert receives mapped opportunity and notifies TradeAlertManager with isMockTrade false`() = runTest {
        val testConfig = TradeSetupConfig(
            strategyId = "ScalperV2",
            symbol = "BTCUSDT",
            entryPrice = 50000.0,
            tradeValueUsdt = 100.0,
            parameters = mapOf("leverage" to "10"),
            riskParameters = mapOf("accountRiskPercent" to 1.0)
        )
        val sessionRepo = createMockSessionRepository("ScalperV2").apply {
            setTradeSetupConfig(testConfig)
        }

        val mockOpportunity = BotAlert(
            id = "mock-alert-uuid-5678",
            symbol = "BTCUSDT",
            entryPrice = 50000.0,
            stopLoss = 49000.0,
            takeProfit = 52000.0,
            estimatedPnl = 4.0,
            strategy = "ScalperV2",
            side = "BUY",
            timestamp = "2026-08-22T12:00:00Z",
            signalPrice = 50000.0,
            targetEntryPrice = 50100.0,
            positionSize = 100.0
        )
        val mockSnapshot = AnalysisSnapshot(
            engineStatus = EngineStatusDTO("ACTIVE", "ScalperV2", System.currentTimeMillis(), 0L, "OK"),
            marketAnalysis = MarketAnalysisDTO("BTCUSDT", "ALIGNED", emptyList(), emptyList(), 85, emptyList()),
            tradingSignal = SignalDTO("BUY", "LONG", 50000.0, 50100.0, 49000.0, 52000.0, "LOW", emptyList()),
            opportunity = mockOpportunity
        )

        var capturedConfig: TradeSetupConfig? = null
        val mockTaRepo = object : TechnicalAnalysisRepository {
            override suspend fun getAnalysis(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<TechnicalAnalysisResult> {
                return NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(400, "Not used", "ERROR"))
            }
            override suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<AnalysisSnapshot> {
                capturedConfig = config
                return NetworkResult.Success(mockSnapshot)
            }
        }

        var receivedAlertMap: Map<String, Any>? = null
        val fakeAlertManager = object : com.cryptopulse.app.service.TradeAlertManager() {
            override fun onNewAlertReceived(alertData: Map<String, Any>) {
                receivedAlertMap = alertData
            }
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = sessionRepo,
            botRepository = createMockBotRepository(),
            technicalAnalysisRepository = mockTaRepo,
            tradeAlertManager = fakeAlertManager
        )

        viewModel.triggerTradeAlert("BTCUSDT", android.content.ContextWrapper(null))
        testDispatcher.scheduler.advanceUntilIdle()

        assertNotNull("TradeAlertManager must receive alert map", receivedAlertMap)
        assertEquals("mock-alert-uuid-5678", receivedAlertMap?.get("id"))
        assertEquals("BTCUSDT", receivedAlertMap?.get("symbol"))
        assertEquals(50000.0, receivedAlertMap?.get("entryPrice"))
        assertEquals(49000.0, receivedAlertMap?.get("stopLoss"))
        assertEquals(52000.0, receivedAlertMap?.get("takeProfit"))
        assertEquals(4.0, receivedAlertMap?.get("estimatedPnl"))
        assertEquals("ScalperV2", receivedAlertMap?.get("strategy"))
        assertEquals("BUY", receivedAlertMap?.get("side"))
        assertEquals(50000.0, receivedAlertMap?.get("signalPrice"))
        assertEquals(50100.0, receivedAlertMap?.get("targetEntryPrice"))
        assertEquals(100.0, receivedAlertMap?.get("positionSize"))
        assertEquals(false, receivedAlertMap?.get("isMockTrade"))
        assertEquals("TEST_TRIGGER", receivedAlertMap?.get("signalOrigin"))
        assertEquals("BUY", capturedConfig?.parameters?.get("forceMockSignal"))
    }
}

private fun createDummyExecResult(id: String) = com.cryptopulse.app.domain.models.TradeExecutionResult(
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
