package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.domain.repository.TechnicalAnalysisRepository
import com.cryptopulse.app.domain.repository.StrategyRepository
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
import org.junit.Assert.assertNull
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
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = MutableStateFlow(null).asStateFlow()
            override val isBotActive: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()

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
            override suspend fun triggerAlert(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<BotAlert> = NetworkResult.Success(BotAlert("mock-alert-uuid-5678", symbol, 50000.0, 49000.0, 52000.0, 4.0, strategy, "BUY", "2026-08-24T00:00:00Z", 50000.0, 50100.0, 100.0, "WAIT_FOR_PRICE"))

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

    private fun createMockStrategyRepository(strategies: List<Strategy> = emptyList()): StrategyRepository {
        return object : StrategyRepository {
            override suspend fun getStrategies(): NetworkResult<List<Strategy>> = NetworkResult.Success(strategies)
            override suspend fun getStrategyById(id: String): NetworkResult<Strategy?> = NetworkResult.Success(strategies.find { it.id == id })
            override fun clearCache() {}
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
            createMockStrategyRepository(),
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
            createMockStrategyRepository(),
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
    fun `triggerTradeAlert receives mapped opportunity and notifies TradeAlertManager without mock trade flag`() = runTest {
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
            strategyRepository = createMockStrategyRepository(),
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
        assertNull("isMockTrade must not be present in production alert map", receivedAlertMap?.get("isMockTrade"))
        assertEquals("MANUAL_TRIGGER", receivedAlertMap?.get("signalOrigin"))
    }

    @Test
    fun `toAnalysisSnapshot maps ScalperV2 strategy metadata correctly with 5m primary timeframe`() {
        val metaDto = com.cryptopulse.app.data.api.dto.bot.response.StrategyMetadataDto(
            strategyId = "ScalperV2",
            displayName = "Scalper V2",
            primaryTimeframe = "5m",
            timeframesAnalyzed = listOf("5m", "15m", "30m"),
            category = "Scalping",
            riskProfile = "High",
            parameters = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("risk_level", "Risk Level", "MEDIUM"),
                com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("mode", "Mode", "AGGRESSIVE")
            ),
            factorContributions = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Trend Alignment", 40, 100, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Momentum Filter", 30, 85, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Volatility Buffer", 15, 100, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Volume Confirmation", 15, 60, "MEDIUM")
            )
        )

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
            conditionsMet = emptyList(),
            opportunity = null,
            timestamp = "2026-08-24T00:00:00Z",
            strategyMetadata = metaDto
        )

        val snapshot = responseDto.toAnalysisSnapshot()

        assertNotNull(snapshot.strategyMetadata)
        assertEquals("Scalper V2", snapshot.strategyMetadata?.displayName)
        assertEquals("5m", snapshot.strategyMetadata?.primaryTimeframe)
        assertEquals(listOf("5m", "15m", "30m"), snapshot.strategyMetadata?.timeframesAnalyzed)
        assertEquals(4, snapshot.strategyMetadata?.factorContributions?.size)
        assertEquals(40, snapshot.strategyMetadata?.factorContributions?.get(0)?.weight)
        assertEquals(30, snapshot.strategyMetadata?.factorContributions?.get(1)?.weight)
    }

    @Test
    fun `toAnalysisSnapshot maps VWAP custom indicators and 30-20-10-40 factor weights`() {
        val metaDto = com.cryptopulse.app.data.api.dto.bot.response.StrategyMetadataDto(
            strategyId = "VWAP",
            displayName = "VWAP Strategy",
            primaryTimeframe = "15m",
            timeframesAnalyzed = listOf("15m", "1h", "4h"),
            category = "Mean Reversion",
            riskProfile = "Medium",
            parameters = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("max_vwap_dev", "Max VWAP Deviation", "3.0%"),
                com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("min_vol_mult", "Min Volume Multiplier", "1.5x")
            ),
            factorContributions = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Trend Alignment", 30, 75, "MEDIUM"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Momentum Filter", 20, 100, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Volatility Buffer", 10, 100, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Volume Confirmation", 40, 100, "HIGH")
            )
        )

        val marketAnalysis = com.cryptopulse.app.data.api.dto.bot.response.MarketAnalysisDto(
            symbol = "BTCUSDT",
            timeframeStatus = "ALIGNED",
            indicatorSummary = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.IndicatorSummaryDto("VWAP Fair Value", "$49,850.00", "BULLISH"),
                com.cryptopulse.app.data.api.dto.bot.response.IndicatorSummaryDto("VWAP Deviation", "0.30%", "BULLISH")
            ),
            conditionSummary = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.ConditionSummaryDto("chk_1", "VWAP Deviation Check", "0.30%", "≤ 3.0%", "PASSED"),
                com.cryptopulse.app.data.api.dto.bot.response.ConditionSummaryDto("chk_2", "Volume Surge", "1.75x", "≥ 1.5x", "PASSED")
            ),
            confidenceScore = 82,
            confidenceExplanation = listOf("VWAP confirmed")
        )

        val responseDto = TechnicalAnalysisResponseDto(
            symbol = "BTCUSDT",
            strategy = "VWAP",
            price = 50000.0,
            change24h = 2.5,
            volume = 1000000.0,
            high24h = 51000.0,
            low24h = 49000.0,
            indicators = emptyMap(),
            signals = emptyMap(),
            checkpoints = emptyList(),
            progress = 82,
            conditionsMet = emptyList(),
            opportunity = null,
            timestamp = "2026-08-24T00:00:00Z",
            marketAnalysis = marketAnalysis,
            strategyMetadata = metaDto
        )

        val snapshot = responseDto.toAnalysisSnapshot()

        assertNotNull(snapshot.strategyMetadata)
        assertEquals("VWAP Strategy", snapshot.strategyMetadata?.displayName)
        assertEquals("15m", snapshot.strategyMetadata?.primaryTimeframe)
        assertEquals(40, snapshot.strategyMetadata?.factorContributions?.find { it.factor == "Volume Confirmation" }?.weight)
        assertEquals("VWAP Fair Value", snapshot.marketAnalysis?.indicatorSummary?.get(0)?.name)
        assertEquals("$49,850.00", snapshot.marketAnalysis?.indicatorSummary?.get(0)?.value)
        assertEquals("≤ 3.0%", snapshot.marketAnalysis?.conditionSummary?.get(0)?.targetValue)
        assertEquals("PASSED", snapshot.marketAnalysis?.conditionSummary?.get(0)?.status)
    }

    @Test
    fun `toAnalysisSnapshot maps MeanReversion EMA separation and 10-40-30-20 factor weights`() {
        val metaDto = com.cryptopulse.app.data.api.dto.bot.response.StrategyMetadataDto(
            strategyId = "MeanReversion",
            displayName = "Mean Reversion",
            primaryTimeframe = "15m",
            timeframesAnalyzed = listOf("15m", "1h"),
            category = "Mean Reversion",
            riskProfile = "Medium-High",
            parameters = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("max_ema_sep", "Max EMA Separation", "5.0%"),
                com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("two_step_conf", "Two-Step Confirmation", "Enabled")
            ),
            factorContributions = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Trend Alignment", 10, 50, "MEDIUM"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Momentum Filter", 40, 100, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Volatility Buffer", 30, 80, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Volume Confirmation", 20, 70, "MEDIUM")
            )
        )

        val marketAnalysis = com.cryptopulse.app.data.api.dto.bot.response.MarketAnalysisDto(
            symbol = "BTCUSDT",
            timeframeStatus = "ALIGNED",
            indicatorSummary = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.IndicatorSummaryDto("EMA Separation", "2.10%", "BULLISH"),
                com.cryptopulse.app.data.api.dto.bot.response.IndicatorSummaryDto("2-Step Reversal", "Oversold Bounce", "BULLISH")
            ),
            conditionSummary = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.ConditionSummaryDto("chk_1", "Trend Moderation", "2.10%", "≤ 5.0%", "PASSED"),
                com.cryptopulse.app.data.api.dto.bot.response.ConditionSummaryDto("chk_2", "RSI Extreme", "22.4", "≤ 25.0", "PASSED")
            ),
            confidenceScore = 78,
            confidenceExplanation = listOf("Mean reversion setup")
        )

        val responseDto = TechnicalAnalysisResponseDto(
            symbol = "BTCUSDT",
            strategy = "MeanReversion",
            price = 50000.0,
            change24h = 2.5,
            volume = 1000000.0,
            high24h = 51000.0,
            low24h = 49000.0,
            indicators = emptyMap(),
            signals = emptyMap(),
            checkpoints = emptyList(),
            progress = 78,
            conditionsMet = emptyList(),
            opportunity = null,
            timestamp = "2026-08-24T00:00:00Z",
            marketAnalysis = marketAnalysis,
            strategyMetadata = metaDto
        )

        val snapshot = responseDto.toAnalysisSnapshot()

        assertNotNull(snapshot.strategyMetadata)
        assertEquals("Mean Reversion", snapshot.strategyMetadata?.displayName)
        assertEquals("15m", snapshot.strategyMetadata?.primaryTimeframe)
        assertEquals(10, snapshot.strategyMetadata?.factorContributions?.find { it.factor == "Trend Alignment" }?.weight)
        assertEquals(40, snapshot.strategyMetadata?.factorContributions?.find { it.factor == "Momentum Filter" }?.weight)
        assertEquals("EMA Separation", snapshot.marketAnalysis?.indicatorSummary?.get(0)?.name)
        assertEquals("2.10%", snapshot.marketAnalysis?.indicatorSummary?.get(0)?.value)
        assertEquals("≤ 5.0%", snapshot.marketAnalysis?.conditionSummary?.get(0)?.targetValue)
    }

    @Test
    fun `toAnalysisSnapshot maps Momentum strategy metadata with 15m primary timeframe and 30-50-10-10 factor weights`() {
        val metaDto = com.cryptopulse.app.data.api.dto.bot.response.StrategyMetadataDto(
            strategyId = "Momentum",
            displayName = "Momentum Trading Strategy",
            primaryTimeframe = "15m",
            timeframesAnalyzed = listOf("15m", "1h", "4h"),
            category = "Trend Following",
            riskProfile = "Medium-High",
            parameters = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("risk_level", "Risk Level", "MEDIUM"),
                com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("mode", "Mode", "AGGRESSIVE")
            ),
            factorContributions = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Trend Alignment", 30, 80, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Momentum Filter", 50, 95, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Volatility Buffer", 10, 60, "MEDIUM"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Volume Confirmation", 10, 70, "MEDIUM")
            )
        )

        val marketAnalysis = com.cryptopulse.app.data.api.dto.bot.response.MarketAnalysisDto(
            symbol = "BTCUSDT",
            timeframeStatus = "ALIGNED",
            indicatorSummary = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.IndicatorSummaryDto("RSI (14) [15m]", "62.5", "BULLISH"),
                com.cryptopulse.app.data.api.dto.bot.response.IndicatorSummaryDto("EMA (50) [15m]", "$49,500.00", "NEUTRAL")
            ),
            conditionSummary = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.ConditionSummaryDto("chk_1", "Trend Alignment (15m)", "Price > EMA(50)", "EMA(50) > EMA(200)", "PASSED"),
                com.cryptopulse.app.data.api.dto.bot.response.ConditionSummaryDto("chk_2", "Momentum Filter (15m)", "MACD Bullish", "RSI(14) [30-70] & MACD > 0", "PASSED")
            ),
            confidenceScore = 84,
            confidenceExplanation = listOf("Momentum confirmed")
        )

        val responseDto = TechnicalAnalysisResponseDto(
            symbol = "BTCUSDT",
            strategy = "Momentum",
            price = 50000.0,
            change24h = 2.5,
            volume = 1000000.0,
            high24h = 51000.0,
            low24h = 49000.0,
            indicators = emptyMap(),
            signals = emptyMap(),
            checkpoints = emptyList(),
            progress = 84,
            conditionsMet = emptyList(),
            opportunity = null,
            timestamp = "2026-08-24T00:00:00Z",
            marketAnalysis = marketAnalysis,
            strategyMetadata = metaDto
        )

        val snapshot = responseDto.toAnalysisSnapshot()

        assertNotNull(snapshot.strategyMetadata)
        assertEquals("Momentum Trading Strategy", snapshot.strategyMetadata?.displayName)
        assertEquals("15m", snapshot.strategyMetadata?.primaryTimeframe)
        assertEquals(listOf("15m", "1h", "4h"), snapshot.strategyMetadata?.timeframesAnalyzed)
        assertEquals(50, snapshot.strategyMetadata?.factorContributions?.find { it.factor == "Momentum Filter" }?.weight)
        assertEquals(30, snapshot.strategyMetadata?.factorContributions?.find { it.factor == "Trend Alignment" }?.weight)
        assertEquals("RSI (14) [15m]", snapshot.marketAnalysis?.indicatorSummary?.get(0)?.name)
        assertEquals("EMA(50) > EMA(200)", snapshot.marketAnalysis?.conditionSummary?.get(0)?.targetValue)
    }

    @Test
    fun `toAnalysisSnapshot maps Breakout strategy metadata with 15m primary timeframe and 30-30-20-20 factor weights`() {
        val metaDto = com.cryptopulse.app.data.api.dto.bot.response.StrategyMetadataDto(
            strategyId = "Breakout",
            displayName = "Breakout Strategy",
            primaryTimeframe = "15m",
            timeframesAnalyzed = listOf("15m", "1h", "4h"),
            category = "Breakout",
            riskProfile = "Medium-High",
            parameters = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("risk_level", "Risk Level", "MEDIUM"),
                com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("mode", "Mode", "AGGRESSIVE")
            ),
            factorContributions = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Trend Alignment", 30, 85, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Momentum Filter", 30, 85, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Volatility Buffer", 20, 90, "HIGH"),
                com.cryptopulse.app.data.api.dto.bot.response.FactorContributionDto("Volume Confirmation", 20, 90, "HIGH")
            )
        )

        val marketAnalysis = com.cryptopulse.app.data.api.dto.bot.response.MarketAnalysisDto(
            symbol = "BTCUSDT",
            timeframeStatus = "ALIGNED",
            indicatorSummary = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.IndicatorSummaryDto("ATR (14) [15m]", "450.00", "NEUTRAL")
            ),
            conditionSummary = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.ConditionSummaryDto("chk_1", "Volatility Expansion (15m)", "Expanding", "ATR(14) Expanding", "PASSED"),
                com.cryptopulse.app.data.api.dto.bot.response.ConditionSummaryDto("chk_2", "Volume Surge (15m)", "Confirmed", "Volume > 1.20x 20MA", "PASSED")
            ),
            confidenceScore = 88,
            confidenceExplanation = listOf("Breakout expansion confirmed")
        )

        val responseDto = TechnicalAnalysisResponseDto(
            symbol = "BTCUSDT",
            strategy = "Breakout",
            price = 50000.0,
            change24h = 2.5,
            volume = 1000000.0,
            high24h = 51000.0,
            low24h = 49000.0,
            indicators = emptyMap(),
            signals = emptyMap(),
            checkpoints = emptyList(),
            progress = 88,
            conditionsMet = emptyList(),
            opportunity = null,
            timestamp = "2026-08-24T00:00:00Z",
            marketAnalysis = marketAnalysis,
            strategyMetadata = metaDto
        )

        val snapshot = responseDto.toAnalysisSnapshot()

        assertNotNull(snapshot.strategyMetadata)
        assertEquals("Breakout Strategy", snapshot.strategyMetadata?.displayName)
        assertEquals("15m", snapshot.strategyMetadata?.primaryTimeframe)
        assertEquals(listOf("15m", "1h", "4h"), snapshot.strategyMetadata?.timeframesAnalyzed)
        assertEquals(20, snapshot.strategyMetadata?.factorContributions?.find { it.factor == "Volume Confirmation" }?.weight)
        assertEquals(20, snapshot.strategyMetadata?.factorContributions?.find { it.factor == "Volatility Buffer" }?.weight)
        assertEquals("ATR(14) Expanding", snapshot.marketAnalysis?.conditionSummary?.get(0)?.targetValue)
        assertEquals("PASSED", snapshot.marketAnalysis?.conditionSummary?.get(0)?.status)
    }

    @Test
    fun `selectStrategy updates activeStrategyId and requests analysis without mutating TradeSessionRepository`() = runTest {
        val sessionRepo = createMockSessionRepository("ScalperV2")
        val initialConfig = TradeSetupConfig(
            strategyId = "ScalperV2",
            symbol = "BTCUSDT",
            entryPrice = 65000.0,
            parameters = mapOf("fastEma" to "9"),
            riskParameters = mapOf("accountRiskPercent" to 1.5),
            entryIntent = EntryIntent.WAIT_FOR_PRICE
        )
        sessionRepo.setTradeSetupConfig(initialConfig)

        var requestedStrategy: String? = null
        var passedConfig: TradeSetupConfig? = null

        val mockTaRepo = object : TechnicalAnalysisRepository {
            override suspend fun getAnalysis(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<TechnicalAnalysisResult> {
                return NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(400, "Mock", "MOCK"))
            }
            override suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<AnalysisSnapshot> {
                requestedStrategy = strategy
                passedConfig = config
                return NetworkResult.Success(createDummySnapshot(strategy, "Momentum Strategy", 80))
            }
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = sessionRepo,
            botRepository = createMockBotRepository(),
            technicalAnalysisRepository = mockTaRepo,
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        // User selects Momentum strategy from TA dropdown
        viewModel.selectStrategy("Momentum", "BTCUSDT")
        testDispatcher.scheduler.advanceUntilIdle()

        // 1. TA activeStrategyId must be updated
        assertEquals("Momentum", viewModel.activeStrategyId.value)
        assertEquals("Momentum", requestedStrategy)

        // 2. Strategy-independent user setup (entryPrice, riskParameters, entryIntent) preserved
        assertEquals(65000.0, passedConfig?.entryPrice)
        assertEquals(1.5, passedConfig?.riskParameters?.get("accountRiskPercent"))
        assertEquals(EntryIntent.WAIT_FOR_PRICE, passedConfig?.entryIntent)

        // 3. Strategy-specific parameters cleared to avoid hybrid config
        assertTrue("Strategy-specific parameters must be empty for newly selected strategy", passedConfig?.parameters?.isEmpty() == true)

        // 4. Committed TradeSessionRepository strategy MUST remain untouched
        assertEquals("ScalperV2", sessionRepo.selectedStrategyId.value)
        assertEquals("ScalperV2", sessionRepo.tradeSetupConfig.value?.strategyId)
    }

    @Test
    fun `stale response protection discards late response from superseded strategy request`() = runTest {
        val sessionRepo = createMockSessionRepository("ScalperV2")
        val botRepo = createMockBotRepository()

        val momentumSnapshot = createDummySnapshot("Momentum", "Momentum Strategy", 85)
        val scalperSnapshot = createDummySnapshot("ScalperV2", "Scalper V2", 20)

        var scalperDeferred: kotlinx.coroutines.CompletableDeferred<NetworkResult<AnalysisSnapshot>>? = null

        val mockTaRepo = object : TechnicalAnalysisRepository {
            override suspend fun getAnalysis(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<TechnicalAnalysisResult> = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(400, "Mock", "MOCK"))
            override suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<AnalysisSnapshot> {
                return if (strategy == "ScalperV2") {
                    val deferred = kotlinx.coroutines.CompletableDeferred<NetworkResult<AnalysisSnapshot>>()
                    scalperDeferred = deferred
                    deferred.await()
                } else {
                    NetworkResult.Success(momentumSnapshot)
                }
            }
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = sessionRepo,
            botRepository = botRepo,
            technicalAnalysisRepository = mockTaRepo,
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        // 1. Start Request A: ScalperV2 (in-flight, waiting on scalperDeferred)
        viewModel.loadPreviewAnalysis("BTCUSDT", "ScalperV2", null)

        // 2. User quickly switches to Request B: Momentum
        viewModel.selectStrategy("Momentum", "BTCUSDT")
        testDispatcher.scheduler.advanceUntilIdle()

        // Momentum returned and should be active in explorationState
        assertEquals("Momentum", viewModel.activeStrategyId.value)
        assertEquals("Momentum Strategy", viewModel.explorationState.value?.strategyMetadata?.displayName)
        assertEquals(85, viewModel.explorationState.value?.marketAnalysis?.confidenceScore)

        // 3. Request A finally arrives late with ScalperV2
        scalperDeferred?.complete(NetworkResult.Success(scalperSnapshot))
        testDispatcher.scheduler.advanceUntilIdle()

        // Active state must STILL be Momentum, NOT overwritten by late ScalperV2 response
        assertEquals("Momentum", viewModel.activeStrategyId.value)
        assertEquals("Momentum Strategy", viewModel.explorationState.value?.strategyMetadata?.displayName)
        assertEquals(85, viewModel.explorationState.value?.marketAnalysis?.confidenceScore)
    }

    @Test
    fun `triggerTradeAlert uses activeStrategyId and cleans cross-strategy parameter overrides`() = runTest {
        val sessionRepo = createMockSessionRepository("ScalperV2")
        val initialConfig = TradeSetupConfig(
            strategyId = "ScalperV2",
            symbol = "BTCUSDT",
            entryPrice = 65000.0,
            parameters = mapOf("fastEma" to "9"),
            riskParameters = mapOf("accountRiskPercent" to 2.0),
            entryIntent = EntryIntent.WAIT_FOR_PRICE
        )
        sessionRepo.setTradeSetupConfig(initialConfig)

        var triggeredStrategy: String? = null
        var triggeredConfig: TradeSetupConfig? = null

        val customBotRepo = object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = MutableStateFlow(null).asStateFlow()
            override val isBotActive: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = "Momentum"))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun executeMockTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult("mock"))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun triggerAlert(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<BotAlert> {
                triggeredStrategy = strategy
                triggeredConfig = config
                return NetworkResult.Success(BotAlert("alert-momentum-1", symbol, 65000.0, 64000.0, 67000.0, 3.0, strategy, "BUY", "2026-08-25T00:00:00Z", 65000.0, 65000.0, 100.0, "WAIT_FOR_PRICE"))
            }
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { _analysisState.value = snapshot }
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        var receivedAlertMap: Map<String, Any>? = null
        val fakeAlertManager = object : com.cryptopulse.app.service.TradeAlertManager() {
            override fun onNewAlertReceived(alertData: Map<String, Any>) {
                receivedAlertMap = alertData
            }
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = sessionRepo,
            botRepository = customBotRepo,
            technicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = fakeAlertManager
        )

        // User switches to Momentum
        viewModel.selectStrategy("Momentum", "BTCUSDT")

        // User presses MOCK TRADE on Technical Analysis screen
        viewModel.triggerTradeAlert("BTCUSDT", android.content.ContextWrapper(null))
        testDispatcher.scheduler.advanceUntilIdle()

        // 1. Alert must be generated for Momentum
        assertEquals("Momentum", triggeredStrategy)
        assertEquals("Momentum", receivedAlertMap?.get("strategy"))

        // 2. Triggered config must have user entryPrice and risk parameters
        assertEquals(65000.0, triggeredConfig?.entryPrice)
        assertEquals(2.0, triggeredConfig?.riskParameters?.get("accountRiskPercent"))

        // 3. Cross-strategy parameter overrides from ScalperV2 must be stripped
        assertTrue(triggeredConfig?.parameters?.isEmpty() == true)
    }

    @Test
    fun `active bot analysis state emissions update ViewModel analysisState dynamically`() = runTest {
        val sessionRepo = createMockSessionRepository("ScalperV2")
        val botAnalysisFlow = MutableStateFlow<AnalysisSnapshot?>(null)
        val isBotActiveFlow = MutableStateFlow(true)
        val committedStrategyFlow = MutableStateFlow<String?>("ScalperV2")

        val customBotRepo = object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = botAnalysisFlow.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = committedStrategyFlow.asStateFlow()
            override val isBotActive: StateFlow<Boolean> = isBotActiveFlow.asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = "ScalperV2"))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun executeMockTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult("mock"))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun triggerAlert(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<BotAlert> = NetworkResult.Success(BotAlert("a1", symbol, 50000.0, 49000.0, 52000.0, 4.0, strategy, "BUY", "2026-08-25T00:00:00Z", 50000.0, 50100.0, 100.0, "WAIT_FOR_PRICE"))
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { botAnalysisFlow.value = snapshot }
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = sessionRepo,
            botRepository = customBotRepo,
            technicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        testDispatcher.scheduler.advanceUntilIdle()
        assertNull("Initially analysisState is null", viewModel.analysisState.value)

        // Emission 1: First live tick from background engine
        val snapshot1 = createDummySnapshot("ScalperV2", "Scalper V2", 65)
        botAnalysisFlow.value = snapshot1
        testDispatcher.scheduler.advanceUntilIdle()

        assertNotNull("analysisState must receive emitted snapshot from botRepository", viewModel.analysisState.value)
        assertEquals(65, viewModel.analysisState.value?.marketAnalysis?.confidenceScore)

        // Emission 2: Second live tick with updated calculations
        val snapshot2 = createDummySnapshot("ScalperV2", "Scalper V2", 88)
        botAnalysisFlow.value = snapshot2
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(88, viewModel.analysisState.value?.marketAnalysis?.confidenceScore)
    }

    @Test
    fun `startPreviewPolling periodically updates analysisState when bot is inactive`() = runTest {
        val sessionRepo = createMockSessionRepository("Momentum")
        var callCount = 0

        val mockTaRepo = object : TechnicalAnalysisRepository {
            override suspend fun getAnalysis(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<TechnicalAnalysisResult> = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(400, "Mock", "MOCK"))
            override suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<AnalysisSnapshot> {
                callCount++
                val score = 50 + (callCount * 10)
                return NetworkResult.Success(createDummySnapshot(strategy, "Momentum", score))
            }
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = sessionRepo,
            botRepository = createMockBotRepository(shouldSucceed = true),
            technicalAnalysisRepository = mockTaRepo,
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        viewModel.selectStrategy("Momentum", "BTC/USDT")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(60, viewModel.analysisState.value?.marketAnalysis?.confidenceScore)

        // Start screen & polling
        viewModel.onScreenStarted("BTC/USDT")
        testDispatcher.scheduler.advanceTimeBy(5500L)
        testDispatcher.scheduler.advanceUntilIdle()

        // Polling loop executed and refreshed analysisState with updated score
        assertTrue("callCount must be >= 2 after polling tick", callCount >= 2)
        assertEquals(70, viewModel.analysisState.value?.marketAnalysis?.confidenceScore)

        // Advance another 5s
        testDispatcher.scheduler.advanceTimeBy(5500L)
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue("callCount must be >= 3 after second polling tick", callCount >= 3)
        assertEquals(80, viewModel.analysisState.value?.marketAnalysis?.confidenceScore)

        viewModel.onScreenStopped()
    }
}

private fun createDummySnapshot(strategy: String, displayName: String, score: Int): AnalysisSnapshot {
    val metaDto = com.cryptopulse.app.data.api.dto.bot.response.StrategyMetadataDto(
        strategyId = strategy,
        displayName = displayName,
        primaryTimeframe = "15m",
        timeframesAnalyzed = listOf("15m"),
        category = "TREND_FOLLOWING",
        riskProfile = "Medium",
        parameters = listOf(
            com.cryptopulse.app.data.api.dto.bot.response.StrategyParameterDto("min_confidence", "Min Confidence", "70%")
        ),
        factorContributions = emptyList()
    )
    val marketAnalysis = com.cryptopulse.app.data.api.dto.bot.response.MarketAnalysisDto(
        symbol = "BTCUSDT",
        timeframeStatus = "ALIGNED",
        indicatorSummary = emptyList(),
        conditionSummary = emptyList(),
        confidenceScore = score,
        confidenceExplanation = emptyList()
    )
    return TechnicalAnalysisResponseDto(
        symbol = "BTCUSDT",
        strategy = strategy,
        price = 65000.0,
        change24h = 1.0,
        volume = 100000.0,
        high24h = 66000.0,
        low24h = 64000.0,
        indicators = emptyMap(),
        signals = emptyMap(),
        checkpoints = emptyList(),
        progress = score,
        conditionsMet = emptyList(),
        opportunity = null,
        timestamp = "2026-08-25T00:00:00Z",
        marketAnalysis = marketAnalysis,
        strategyMetadata = metaDto
    ).toAnalysisSnapshot()
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
