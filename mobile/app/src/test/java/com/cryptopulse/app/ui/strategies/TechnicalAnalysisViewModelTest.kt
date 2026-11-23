package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.data.api.ApiConstants
import com.cryptopulse.app.data.api.TradingBotService
import com.cryptopulse.app.data.datasource.remote.bot.BotRemoteDataSource
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.domain.repository.TechnicalAnalysisRepository
import com.cryptopulse.app.domain.repository.StrategyRepository
import com.cryptopulse.app.domain.models.ExecutionUiState
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
import com.cryptopulse.app.ui.screens.resolveStrategyScoreCardStatusText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import com.cryptopulse.app.data.api.dto.technicalanalysis.response.TechnicalAnalysisResponseDto
import com.cryptopulse.app.data.mapper.technicalanalysis.toAnalysisSnapshot
import com.cryptopulse.app.data.mapper.bot.toDomain

@OptIn(ExperimentalCoroutinesApi::class)
class TechnicalAnalysisViewModelTest {

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

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                return if (shouldSucceed) {
                    NetworkResult.Success(Unit)
                } else {
                    NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(400, "Failed", "ERROR"))
                }
            }

            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = "ScalperV2"))
            override suspend fun executeTrade(alertId: String): NetworkResult<com.cryptopulse.app.domain.models.TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<com.cryptopulse.app.domain.models.TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<com.cryptopulse.app.domain.models.TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)

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

    // ========================================================================
    // Consolidated Helper: RecordingBotRepository for Activation Tests
    // ========================================================================
    private class ActivationRecordingBotRepository : BotRepository {
        var activateCallCount = 0
        var lastActivatedSymbol: String? = null
        var lastActivatedStrategy: String? = null
        var lastActivatedConfig: TradeSetupConfig? = null
        var activateResultProvider: suspend () -> NetworkResult<Unit> = { NetworkResult.Success(Unit) }

        var deactivateCallCount = 0
        var deactivateResultProvider: suspend () -> NetworkResult<Unit> = { NetworkResult.Success(Unit) }

        private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
        override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
        override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
        override val committedStrategyId: StateFlow<String?> = MutableStateFlow(null).asStateFlow()
        override val isBotActive: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()

        private val _isConnected = MutableStateFlow(true)
        override val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

        var lastActivatedSymbols: List<String>? = null

        override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
            activateCallCount++
            lastActivatedSymbols = symbols
            lastActivatedSymbol = symbols.firstOrNull()
            lastActivatedStrategy = strategy
            lastActivatedConfig = config
            return activateResultProvider()
        }

        override suspend fun executeTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto): NetworkResult<TradeExecutionResult> =
            NetworkResult.Error(NetworkError.Unknown(Exception("Not implemented")))

        override suspend fun deactivateBot(): NetworkResult<Unit> {
            deactivateCallCount++
            return deactivateResultProvider()
        }

        override suspend fun getStatus(): NetworkResult<BotStatus> =
            NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = "ScalperV2"))
        override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> =
            NetworkResult.Error(NetworkError.Unknown(Exception("Not implemented")))
        override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> =
            NetworkResult.Error(NetworkError.Unknown(Exception("Not implemented")))
        override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long) =
            kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
        override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
        override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override fun updateAnalysisState(snapshot: AnalysisSnapshot?) {}
        override fun updateConnectionState(connected: Boolean) {}
        override fun startObserving() {}
        override fun stopObserving() {}
    }

    private fun createActivationViewModel(
        sessionRepository: TradeSessionRepository = createMockSessionRepository("ScalperV2"),
        botRepository: BotRepository = ActivationRecordingBotRepository(),
        technicalAnalysisRepository: TechnicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
        strategyRepository: StrategyRepository = createMockStrategyRepository()
    ): TechnicalAnalysisViewModel {
        return TechnicalAnalysisViewModel(
            sessionRepository = sessionRepository,
            botRepository = botRepository,
            technicalAnalysisRepository = technicalAnalysisRepository,
            strategyRepository = strategyRepository,
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )
    }

    private fun isUseThisStrategyButtonEnabled(isActivating: Boolean): Boolean = !isActivating
    private fun isDeactivateBotButtonEnabled(isActivating: Boolean, isLoading: Boolean): Boolean = !isActivating && !isLoading
    private fun isActivationErrorBannerVisible(activationError: String?): Boolean = !activationError.isNullOrBlank()

    private fun calculateClampedProgress(score: Int): Float = (score / 100f).coerceIn(0f, 1f)
    private fun generateIndicatorKey(index: Int, indicator: IndicatorSummary): String = "${indicator.name}_$index"
    private fun generateCheckpointKey(index: Int, checkpoint: ConditionSummary): String = "${checkpoint.id.ifBlank { checkpoint.name }}_$index"

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
        assertEquals(4.0, alert.estimatedPnl!!, 0.0001)
        assertEquals("ScalperV2", alert.strategy)
        assertEquals("BUY", alert.side)
        assertEquals(50000.0, alert.signalPrice ?: 0.0, 0.0001)
        assertEquals(50100.0, alert.targetEntryPrice ?: 0.0, 0.0001)
        assertEquals(100.0, alert.positionSize ?: 0.0, 0.0001)
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

        // 1. TA viewedStrategyId must be updated
        assertEquals("Momentum", viewModel.viewedStrategyId.value)
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
        assertEquals("Momentum", viewModel.viewedStrategyId.value)
        assertEquals("Momentum Strategy", viewModel.explorationState.value?.strategyMetadata?.displayName)
        assertEquals(85, viewModel.explorationState.value?.marketAnalysis?.confidenceScore)

        // 3. Request A finally arrives late with ScalperV2
        scalperDeferred?.complete(NetworkResult.Success(scalperSnapshot))
        testDispatcher.scheduler.advanceUntilIdle()

        // Active state must STILL be Momentum, NOT overwritten by late ScalperV2 response
        assertEquals("Momentum", viewModel.viewedStrategyId.value)
        assertEquals("Momentum Strategy", viewModel.explorationState.value?.strategyMetadata?.displayName)
        assertEquals(85, viewModel.explorationState.value?.marketAnalysis?.confidenceScore)
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

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = "ScalperV2"))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
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
        testDispatcher.scheduler.runCurrent()

        // Polling loop executed and refreshed analysisState with updated score
        assertTrue("callCount must be >= 2 after polling tick", callCount >= 2)
        assertEquals(70, viewModel.analysisState.value?.marketAnalysis?.confidenceScore)

        // Advance another 5s
        testDispatcher.scheduler.advanceTimeBy(5500L)
        testDispatcher.scheduler.runCurrent()

        assertTrue("callCount must be >= 3 after second polling tick", callCount >= 3)
        assertEquals(80, viewModel.analysisState.value?.marketAnalysis?.confidenceScore)

        viewModel.onScreenStopped()
    }

    @Test
    fun `TEST 1 and 2 and 3 - browsing strategies when bot is active on VWAP does not alter active bot state or activate bot`() = runTest {
        val sessionRepo = createMockSessionRepository("VWAP")
        val isBotActiveFlow = MutableStateFlow(true)
        val committedStrategyFlow = MutableStateFlow<String?>("VWAP")
        var activateBotCallCount = 0

        val customBotRepo = object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = committedStrategyFlow.asStateFlow()
            override val isBotActive: StateFlow<Boolean> = isBotActiveFlow.asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                activateBotCallCount++
                committedStrategyFlow.value = strategy
                return NetworkResult.Success(Unit)
            }
            override suspend fun deactivateBot(): NetworkResult<Unit> {
                committedStrategyFlow.value = null
                isBotActiveFlow.value = false
                return NetworkResult.Success(Unit)
            }
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = "VWAP"))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { _analysisState.value = snapshot }
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        var taCallCount = 0
        var lastRequestedStrategy: String? = null
        val mockTaRepo = object : TechnicalAnalysisRepository {
            override suspend fun getAnalysis(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<TechnicalAnalysisResult> = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(400, "Mock", "MOCK"))
            override suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<AnalysisSnapshot> {
                taCallCount++
                lastRequestedStrategy = strategy
                return NetworkResult.Success(createDummySnapshot(strategy, strategy, 75))
            }
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = sessionRepo,
            botRepository = customBotRepo,
            technicalAnalysisRepository = mockTaRepo,
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        // Initial active state is VWAP
        assertEquals("VWAP", viewModel.activeStrategyId.value)
        assertTrue(viewModel.isBotActive.value)

        // TEST 1: Tap Scalper V2
        viewModel.selectStrategyForViewing("ScalperV2", "BTCUSDT")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("ScalperV2", viewModel.viewedStrategyId.value)
        assertEquals("VWAP", viewModel.activeStrategyId.value)
        assertEquals("ScalperV2", lastRequestedStrategy)
        assertEquals(0, activateBotCallCount) // ZERO activation calls

        // TEST 2: Tap Breakout
        viewModel.selectStrategyForViewing("Breakout", "BTCUSDT")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("Breakout", viewModel.viewedStrategyId.value)
        assertEquals("VWAP", viewModel.activeStrategyId.value)
        assertEquals("Breakout", lastRequestedStrategy)
        assertEquals(0, activateBotCallCount)

        // TEST 3: Tap Momentum, MeanReversion, VWAP
        viewModel.selectStrategyForViewing("Momentum", "BTCUSDT")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("Momentum", viewModel.viewedStrategyId.value)
        assertEquals("VWAP", viewModel.activeStrategyId.value)

        viewModel.selectStrategyForViewing("MeanReversion", "BTCUSDT")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("MeanReversion", viewModel.viewedStrategyId.value)
        assertEquals("VWAP", viewModel.activeStrategyId.value)

        viewModel.selectStrategyForViewing("VWAP", "BTCUSDT")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("VWAP", viewModel.viewedStrategyId.value)
        assertEquals("VWAP", viewModel.activeStrategyId.value)
        assertEquals(0, activateBotCallCount) // Never activated during browsing
    }

    @Test
    fun `TEST 4 - preview polling continues refreshing Scalper V2 while active bot is running VWAP`() = runTest {
        val sessionRepo = createMockSessionRepository("VWAP")
        val isBotActiveFlow = MutableStateFlow(true)
        val committedStrategyFlow = MutableStateFlow<String?>("VWAP")
        var activateBotCallCount = 0

        val customBotRepo = object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = committedStrategyFlow.asStateFlow()
            override val isBotActive: StateFlow<Boolean> = isBotActiveFlow.asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                activateBotCallCount++
                return NetworkResult.Success(Unit)
            }
            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = "VWAP"))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { _analysisState.value = snapshot }
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        var previewCallCount = 0
        val mockTaRepo = object : TechnicalAnalysisRepository {
            override suspend fun getAnalysis(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<TechnicalAnalysisResult> = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(400, "Mock", "MOCK"))
            override suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<AnalysisSnapshot> {
                if (strategy == "ScalperV2") {
                    previewCallCount++
                }
                return NetworkResult.Success(createDummySnapshot(strategy, strategy, 50 + previewCallCount * 5))
            }
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = sessionRepo,
            botRepository = customBotRepo,
            technicalAnalysisRepository = mockTaRepo,
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        // User previews Scalper V2 while bot is active on VWAP
        viewModel.selectStrategyForViewing("ScalperV2", "BTCUSDT")
        testDispatcher.scheduler.advanceTimeBy(100L)
        testDispatcher.scheduler.runCurrent()
        assertEquals(1, previewCallCount)

        viewModel.onScreenStarted("BTCUSDT")

        // Wait 1 polling interval (5500ms)
        testDispatcher.scheduler.advanceTimeBy(5500L)
        testDispatcher.scheduler.runCurrent()

        assertTrue("Preview polling MUST continue when viewed strategy is different from active bot", previewCallCount >= 2)
        assertEquals("ScalperV2", viewModel.viewedStrategyId.value)
        assertEquals("VWAP", viewModel.activeStrategyId.value)
        assertEquals(0, activateBotCallCount) // NO activation occurs

        // Wait another polling interval
        testDispatcher.scheduler.advanceTimeBy(5500L)
        testDispatcher.scheduler.runCurrent()

        assertTrue("Preview polling MUST continue refreshing on second interval", previewCallCount >= 3)
        assertEquals("ScalperV2", viewModel.viewedStrategyId.value)
        assertEquals("VWAP", viewModel.activeStrategyId.value)
        assertEquals(0, activateBotCallCount)

        viewModel.onScreenStopped()
        testDispatcher.scheduler.runCurrent()
    }

    @Test
    fun `TEST 5 - SWITCH BOT explicitly activates Scalper V2 and updates activeStrategyId`() = runTest {
        val sessionRepo = createMockSessionRepository("VWAP")
        val isBotActiveFlow = MutableStateFlow(true)
        val committedStrategyFlow = MutableStateFlow<String?>("VWAP")
        var activateCalledWithStrategy: String? = null

        val customBotRepo = object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = committedStrategyFlow.asStateFlow()
            override val isBotActive: StateFlow<Boolean> = isBotActiveFlow.asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                activateCalledWithStrategy = strategy
                committedStrategyFlow.value = strategy
                return NetworkResult.Success(Unit)
            }
            override suspend fun deactivateBot(): NetworkResult<Unit> {
                committedStrategyFlow.value = null
                isBotActiveFlow.value = false
                return NetworkResult.Success(Unit)
            }
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = committedStrategyFlow.value))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { _analysisState.value = snapshot }
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

        // Preview Scalper V2 while active bot is VWAP
        viewModel.selectStrategyForViewing("ScalperV2", "BTCUSDT")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("ScalperV2", viewModel.viewedStrategyId.value)
        assertEquals("VWAP", viewModel.activeStrategyId.value)
        assertNull(activateCalledWithStrategy)

        // User explicitly taps "SWITCH BOT TO THIS STRATEGY"
        var callbackInvoked = false
        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {
            callbackInvoked = true
        }
        testDispatcher.scheduler.advanceUntilIdle()

        // Explicit activation must succeed
        assertTrue(callbackInvoked)
        assertEquals("ScalperV2", activateCalledWithStrategy)
        assertEquals("ScalperV2", viewModel.activeStrategyId.value)
        assertEquals("ScalperV2", viewModel.committedStrategyId.value)
    }

    @Test
    fun `sanitizeConfigForStrategy preserves legitimate target parameters, sets symbol, and strips cross-strategy overrides`() = runTest {
        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = createMockSessionRepository("ScalperV2"),
            botRepository = createMockBotRepository(),
            technicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        val baseConfig = TradeSetupConfig(
            strategyId = "ScalperV2",
            symbol = "ETHUSDT",
            entryPrice = 3000.0,
            parameters = mapOf("fast_ema" to "9", "slow_ema" to "21"),
            riskParameters = mapOf("accountRiskPercent" to 1.5, "riskRewardRatio" to 2.0)
        )

        // Case 1: Target strategy is ScalperV2 (same strategy) on new symbol BTCUSDT
        val sameStrategyClean = viewModel.sanitizeConfigForStrategy(baseConfig, "ScalperV2", "BTCUSDT")
        assertEquals("ScalperV2", sameStrategyClean.strategyId)
        assertEquals("BTCUSDT", sameStrategyClean.symbol) // Guaranteed symbol update
        assertEquals("9", sameStrategyClean.parameters["fast_ema"]) // Preserves legitimate Scalper custom parameters
        assertEquals(1.5, sameStrategyClean.riskParameters["accountRiskPercent"]) // Preserves user risk parameters

        // Case 2: Target strategy is Momentum (different strategy) on BTCUSDT
        val crossStrategyClean = viewModel.sanitizeConfigForStrategy(baseConfig, "Momentum", "BTCUSDT")
        assertEquals("Momentum", crossStrategyClean.strategyId)
        assertEquals("BTCUSDT", crossStrategyClean.symbol)
        assertTrue("Incompatible cross-strategy parameters must be stripped", crossStrategyClean.parameters.isEmpty())
        assertEquals(1.5, crossStrategyClean.riskParameters["accountRiskPercent"]) // Preserves user risk parameters
        assertEquals(3000.0, crossStrategyClean.entryPrice, 0.0)
    }

    @Test
    fun `strict active bot snapshot filter requires ALL 3 conditions (isBotActive, committedId == viewedId, snapshotId == committedId)`() = runTest {
        val botAnalysisFlow = MutableStateFlow<AnalysisSnapshot?>(null)
        val isBotActiveFlow = MutableStateFlow(true)
        val committedStrategyFlow = MutableStateFlow<String?>("VWAP")

        val customBotRepo = object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = botAnalysisFlow.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = committedStrategyFlow.asStateFlow()
            override val isBotActive: StateFlow<Boolean> = isBotActiveFlow.asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = "VWAP"))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { botAnalysisFlow.value = snapshot }
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = createMockSessionRepository("VWAP"),
            botRepository = customBotRepo,
            technicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        // User is viewing ScalperV2 while bot is active on VWAP
        viewModel.selectStrategyForViewing("ScalperV2", "BTCUSDT")
        testDispatcher.scheduler.advanceUntilIdle()

        // Bot emits active VWAP snapshot (snapshotStrategyId = "VWAP")
        val vwapSnapshot = createDummySnapshot("VWAP", "VWAP", 90)
        botAnalysisFlow.value = vwapSnapshot
        testDispatcher.scheduler.advanceUntilIdle()

        // explorationState must NOT be overwritten by active VWAP snapshot because viewedStrategyId is ScalperV2
        assertNotEquals("VWAP snapshot must NOT leak into ScalperV2 preview", "VWAP", viewModel.explorationState.value?.strategyMetadata?.strategyId)

        // User switches view to VWAP (viewedStrategyId = "VWAP")
        viewModel.selectStrategyForViewing("VWAP", "BTCUSDT")
        testDispatcher.scheduler.advanceUntilIdle()

        // Emitting VWAP snapshot now matches ALL 3 conditions
        val updatedVwapSnapshot = createDummySnapshot("VWAP", "VWAP", 95)
        botAnalysisFlow.value = updatedVwapSnapshot
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("VWAP", viewModel.explorationState.value?.strategyMetadata?.strategyId)
        assertEquals(95, viewModel.explorationState.value?.marketAnalysis?.confidenceScore)
    }

    @Test
    fun `double-tap concurrency guard prevents duplicate activateBot and stopBot requests`() = runTest {
        var activateCallCount = 0
        var deactivateCallCount = 0

        val customBotRepo = object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()
            override val isBotActive: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                activateCallCount++
                kotlinx.coroutines.delay(100) // simulate network latency
                return NetworkResult.Success(Unit)
            }
            override suspend fun deactivateBot(): NetworkResult<Unit> {
                deactivateCallCount++
                kotlinx.coroutines.delay(100)
                return NetworkResult.Success(Unit)
            }
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = "ScalperV2"))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { _analysisState.value = snapshot }
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = createMockSessionRepository("ScalperV2"),
            botRepository = customBotRepo,
            technicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        // Rapid double tap activateBot
        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}
        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("Exactly ONE activateBot call should be dispatched", 1, activateCallCount)

        // Rapid double tap stopBot
        viewModel.stopBot {}
        viewModel.stopBot {}
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("Exactly ONE deactivateBot call should be dispatched", 1, deactivateCallCount)
    }

    @Test
    fun `TEST H - all 10 deterministic strategy and activation combinations (H1_1 through H5_2)`() = runTest {
        val strategies = listOf("ScalperV2", "Momentum", "Breakout", "MeanReversion", "VWAP")

        for (strategy in strategies) {
            // Sub-test X.1: Active Bot == Viewed Strategy (isViewingActiveBot == true)
            val committedFlowSame = MutableStateFlow<String?>(strategy)
            val isBotActiveFlowSame = MutableStateFlow(true)
            var deactivated = false

            val botRepoSame = object : BotRepository {
                private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
                override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
                override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
                override val committedStrategyId: StateFlow<String?> = committedFlowSame.asStateFlow()
                override val isBotActive: StateFlow<Boolean> = isBotActiveFlowSame.asStateFlow()
                override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

                override suspend fun activateBot(symbols: List<String>, strat: String, config: TradeSetupConfig?): NetworkResult<Unit> = NetworkResult.Success(Unit)
                override suspend fun deactivateBot(): NetworkResult<Unit> {
                    deactivated = true
                    return NetworkResult.Success(Unit)
                }
                override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = strategy))
                override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
                    override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
                override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
                override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
                override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
                override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
                    override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { _analysisState.value = snapshot }
                override fun updateConnectionState(connected: Boolean) {}
                override fun startObserving() {}
                override fun stopObserving() {}
            }

            val viewModelSame = TechnicalAnalysisViewModel(
                sessionRepository = createMockSessionRepository(strategy),
                botRepository = botRepoSame,
                technicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
                strategyRepository = createMockStrategyRepository(),
                tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
            )

            viewModelSame.selectStrategyForViewing(strategy, "BTCUSDT")
            testDispatcher.scheduler.advanceUntilIdle()

            // State check for Case X.1: Active Bot == Viewed Strategy
            val isViewingActiveBot = viewModelSame.isBotActive.value &&
                !viewModelSame.committedStrategyId.value.isNullOrBlank() &&
                viewModelSame.viewedStrategyId.value.equals(viewModelSame.committedStrategyId.value, ignoreCase = true)

            assertTrue("When active strategy ($strategy) == viewed strategy ($strategy), isViewingActiveBot MUST be true", isViewingActiveBot)
            
            viewModelSame.stopBot {}
            testDispatcher.scheduler.advanceUntilIdle()
            assertTrue("Pressing action button when viewing active strategy must call deactivateBot", deactivated)


            // Sub-test X.2: Active Bot != Viewed Strategy (isViewingActiveBot == false)
            val differentActiveStrategy = if (strategy == "VWAP") "ScalperV2" else "VWAP"
            val committedFlowDiff = MutableStateFlow<String?>(differentActiveStrategy)
            val isBotActiveFlowDiff = MutableStateFlow(true)
            var activatedWithStrategy: String? = null

            val botRepoDiff = object : BotRepository {
                private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
                override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
                override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
                override val committedStrategyId: StateFlow<String?> = committedFlowDiff.asStateFlow()
                override val isBotActive: StateFlow<Boolean> = isBotActiveFlowDiff.asStateFlow()
                override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

                override suspend fun activateBot(symbols: List<String>, strat: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                    activatedWithStrategy = strat
                    return NetworkResult.Success(Unit)
                }
                override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
                override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.ANALYSING, isActive = true, coinId = "BTCUSDT", strategy = differentActiveStrategy))
                override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
                    override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
                override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
                override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
                override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
                override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
                    override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { _analysisState.value = snapshot }
                override fun updateConnectionState(connected: Boolean) {}
                override fun startObserving() {}
                override fun stopObserving() {}
            }

            val viewModelDiff = TechnicalAnalysisViewModel(
                sessionRepository = createMockSessionRepository(strategy),
                botRepository = botRepoDiff,
                technicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
                strategyRepository = createMockStrategyRepository(),
                tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
            )

            viewModelDiff.selectStrategyForViewing(strategy, "BTCUSDT")
            testDispatcher.scheduler.advanceUntilIdle()

            // State check for Case X.2: Active Bot != Viewed Strategy
            val isViewingActiveBotDiff = viewModelDiff.isBotActive.value &&
                !viewModelDiff.committedStrategyId.value.isNullOrBlank() &&
                viewModelDiff.viewedStrategyId.value.equals(viewModelDiff.committedStrategyId.value, ignoreCase = true)

            assertFalse("When active strategy ($differentActiveStrategy) != viewed strategy ($strategy), isViewingActiveBot MUST be false", isViewingActiveBotDiff)

            viewModelDiff.activateBot("BTCUSDT", strategy, null) {}
            testDispatcher.scheduler.advanceUntilIdle()
            assertEquals("Pressing action button when viewed strategy is not active must call activateBot with viewed strategy", strategy, activatedWithStrategy)
        }
    }

    @Test
    fun `multi-strategy snapshot parses all five canonical strategy evaluations independently`() = runTest {
        val dto = com.cryptopulse.app.data.api.dto.bot.response.AnalysisSnapshotDto(
            isActive = true,
            strategyAnalyses = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(
                    strategyId = "ScalperV2",
                    confidenceScore = 78,
                    requiredScore = 75,
                    hasSignal = true,
                    signalType = "BUY",
                    qualificationStatus = "QUALIFIED",
                    timestamp = 1727500000000L
                ),
                com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(
                    strategyId = "Momentum",
                    confidenceScore = 65,
                    requiredScore = 70,
                    hasSignal = false,
                    signalType = null,
                    qualificationStatus = "NOT_MET",
                    timestamp = 1727500000000L
                ),
                com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(
                    strategyId = "Breakout",
                    confidenceScore = 72,
                    requiredScore = 70,
                    hasSignal = true,
                    signalType = "SELL",
                    qualificationStatus = "QUALIFIED",
                    timestamp = 1727500000000L
                ),
                com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(
                    strategyId = "MeanReversion",
                    confidenceScore = null,
                    requiredScore = 75,
                    hasSignal = false,
                    signalType = null,
                    qualificationStatus = "PENDING",
                    timestamp = 1727500000000L
                ),
                com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(
                    strategyId = "VWAP",
                    confidenceScore = 80,
                    requiredScore = 70,
                    hasSignal = true,
                    signalType = "BUY",
                    qualificationStatus = "QUALIFIED",
                    timestamp = 1727500000000L
                )
            )
        )

        val domain = dto.toDomain()
        assertEquals("Must parse all 5 strategy evaluations", 5, domain.strategyAnalyses.size)

        val scalper = domain.strategyAnalyses.find { it.strategyId.equals("ScalperV2", ignoreCase = true) }
        assertNotNull(scalper)
        assertEquals(78, scalper!!.confidenceScore)
        assertEquals(75, scalper.requiredScore)
        assertTrue(scalper.hasSignal)
        assertEquals("BUY", scalper.signalType)
        assertEquals("QUALIFIED", scalper.qualificationStatus)

        val meanReversion = domain.strategyAnalyses.find { it.strategyId.equals("MeanReversion", ignoreCase = true) }
        assertNotNull(meanReversion)
        assertNull("Score must be null, never false 0", meanReversion!!.confidenceScore)
        assertEquals(75, meanReversion.requiredScore)
        assertFalse(meanReversion.hasSignal)
        assertEquals("PENDING", meanReversion.qualificationStatus)
    }

    @Test
    fun `strategy card data mapping locates results by strategyId rather than array index`() = runTest {
        // Reverse array order to prove mapping is ID-keyed and immune to index order
        val reversedEvaluations = listOf(
            com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(strategyId = "VWAP", confidenceScore = 91, requiredScore = 70),
            com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(strategyId = "MeanReversion", confidenceScore = 55, requiredScore = 75),
            com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(strategyId = "Breakout", confidenceScore = 73, requiredScore = 70),
            com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(strategyId = "Momentum", confidenceScore = 68, requiredScore = 70),
            com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(strategyId = "ScalperV2", confidenceScore = 82, requiredScore = 75)
        )

        val dto = com.cryptopulse.app.data.api.dto.bot.response.AnalysisSnapshotDto(strategyAnalyses = reversedEvaluations)
        val domain = dto.toDomain()

        // Find strictly by strategyId
        val scalper = domain.strategyAnalyses.find { it.strategyId.equals("ScalperV2", ignoreCase = true) }
        val vwap = domain.strategyAnalyses.find { it.strategyId.equals("VWAP", ignoreCase = true) }

        assertEquals(82, scalper?.confidenceScore)
        assertEquals(91, vwap?.confidenceScore)
    }

    @Test
    fun `strategy evaluation preserves null requiredScore without hardcoding fallback thresholds`() = runTest {
        val dto = com.cryptopulse.app.data.api.dto.bot.response.AnalysisSnapshotDto(
            strategyAnalyses = listOf(
                com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(
                    strategyId = "ScalperV2",
                    confidenceScore = 80,
                    requiredScore = null
                ),
                com.cryptopulse.app.data.api.dto.bot.response.StrategyEvaluationDto(
                    strategyId = "Momentum",
                    confidenceScore = 65,
                    requiredScore = 72
                )
            )
        )
        val domain = dto.toDomain()
        val scalper = domain.strategyAnalyses.find { it.strategyId.equals("ScalperV2", ignoreCase = true) }
        val momentum = domain.strategyAnalyses.find { it.strategyId.equals("Momentum", ignoreCase = true) }

        assertNotNull(scalper)
        assertNull("Missing requiredScore must remain null and not invent fallback 75 or 70", scalper?.requiredScore)

        assertNotNull(momentum)
        assertEquals(72, momentum?.requiredScore)
    }

    @Test
    fun `activateAutonomousBot dispatches activateBot with canonical registered ScalperV2`() = runTest {
        var dispatchedStrategy: String? = null
        var dispatchedSymbols: List<String>? = null

        val customBotRepo = object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()
            override val isBotActive: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                dispatchedSymbols = symbols
                dispatchedStrategy = strategy
                return NetworkResult.Success(Unit)
            }
            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.STOPPED, isActive = false, coinId = null, strategy = null))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) {}
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = createMockSessionRepository("ScalperV2"),
            botRepository = customBotRepo,
            technicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        var successCalled = false
        viewModel.activateAutonomousBot(listOf("BTCUSDT", "ETHUSDT"), null) {
            successCalled = true
        }
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue(successCalled)
        assertEquals("Must use canonical registered ScalperV2 for activation", "ScalperV2", dispatchedStrategy)
        assertEquals(listOf("BTCUSDT", "ETHUSDT"), dispatchedSymbols)
    }

    @Test
    fun `activateAutonomousBot with empty candidate list blocks activation and never calls repository`() = runTest {
        var activateCalled = false

        val customBotRepo = object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()
            override val isBotActive: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                activateCalled = true
                return NetworkResult.Success(Unit)
            }
            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.STOPPED, isActive = false, coinId = null, strategy = null))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) {}
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = createMockSessionRepository("ScalperV2"),
            botRepository = customBotRepo,
            technicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        var successCalled = false
        viewModel.activateAutonomousBot(emptyList(), null) {
            successCalled = true
        }
        testDispatcher.scheduler.advanceUntilIdle()

        assertFalse("Activation success callback must not be called when candidates are empty", successCalled)
        assertFalse("BotRepository.activateBot must not be invoked when candidates are empty", activateCalled)
        assertEquals("Cannot activate bot: no eligible candidates available.", viewModel.activationError.value)
    }

    @Test
    fun `activateAutonomousBot with multiple candidates passes all symbols without single-symbol fallback`() = runTest {
        var dispatchedSymbols: List<String>? = null
        val candidatesList = listOf("CL/USDT", "SOL/USDT", "QNT/USDT", "ZEC/USDT", "HYPE/USDT", "ETH/USDT")

        val customBotRepo = object : BotRepository {
            private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
            override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()
            override val committedStrategyId: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()
            override val isBotActive: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()
            override val isConnected: StateFlow<Boolean> = MutableStateFlow(true).asStateFlow()

            override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> {
                dispatchedSymbols = symbols
                return NetworkResult.Success(Unit)
            }
            override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getStatus(): NetworkResult<BotStatus> = NetworkResult.Success(BotStatus(state = BotState.STOPPED, isActive = false, coinId = null, strategy = null))
            override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(alertId))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = NetworkResult.Success(createDummyExecResult(positionId))
            override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecResult(positionId))
            override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
            override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override fun updateAnalysisState(snapshot: AnalysisSnapshot?) {}
            override fun updateConnectionState(connected: Boolean) {}
            override fun startObserving() {}
            override fun stopObserving() {}
        }

        val viewModel = TechnicalAnalysisViewModel(
            sessionRepository = createMockSessionRepository("ScalperV2"),
            botRepository = customBotRepo,
            technicalAnalysisRepository = createMockTechnicalAnalysisRepository(),
            strategyRepository = createMockStrategyRepository(),
            tradeAlertManager = com.cryptopulse.app.service.TradeAlertManager()
        )

        var successCalled = false
        viewModel.activateAutonomousBot(candidatesList, null) {
            successCalled = true
        }
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue(successCalled)
        assertEquals("Must pass all candidate symbols without fallback", candidatesList, dispatchedSymbols)
        assertEquals(6, dispatchedSymbols?.size)
        assertNull(viewModel.activationError.value)
    }

    // ========================================================================
    // CONSOLIDATED FROM TechnicalAnalysisSafetyTest (13 Tests)
    // ========================================================================

    @Test
    fun `clamped progress should safely constrain negative scores to 0`() {
        val progress = calculateClampedProgress(-25)
        assertEquals(0f, progress, 0.0001f)
    }

    @Test
    fun `clamped progress should produce exact 0 for zero score`() {
        val progress = calculateClampedProgress(0)
        assertEquals(0f, progress, 0.0001f)
    }

    @Test
    fun `clamped progress should produce exact fractional value for normal score`() {
        val progress = calculateClampedProgress(75)
        assertEquals(0.75f, progress, 0.0001f)
    }

    @Test
    fun `clamped progress should produce exact 1 for 100 score`() {
        val progress = calculateClampedProgress(100)
        assertEquals(1.0f, progress, 0.0001f)
    }

    @Test
    fun `clamped progress should safely constrain overflow scores to 1`() {
        val progress = calculateClampedProgress(125)
        assertEquals(1.0f, progress, 0.0001f)
    }

    @Test
    fun `duplicate indicator names should produce guaranteed unique composite keys`() {
        val indicators = listOf(
            IndicatorSummary(name = "RSI", value = "65.0", signal = "BULLISH"),
            IndicatorSummary(name = "RSI", value = "70.0", signal = "BULLISH"),
            IndicatorSummary(name = "RSI", value = "55.0", signal = "NEUTRAL")
        )

        val keys = indicators.mapIndexed { index, indicator -> generateIndicatorKey(index, indicator) }

        assertEquals(3, keys.toSet().size)
        assertEquals("RSI_0", keys[0])
        assertEquals("RSI_1", keys[1])
        assertEquals("RSI_2", keys[2])
    }

    @Test
    fun `blank indicator names should produce guaranteed unique composite keys`() {
        val indicators = listOf(
            IndicatorSummary(name = "", value = "10.0", signal = "NEUTRAL"),
            IndicatorSummary(name = "", value = "20.0", signal = "NEUTRAL")
        )

        val keys = indicators.mapIndexed { index, indicator -> generateIndicatorKey(index, indicator) }

        assertEquals(2, keys.toSet().size)
        assertEquals("_0", keys[0])
        assertEquals("_1", keys[1])
    }

    @Test
    fun `duplicate checkpoint IDs should produce guaranteed unique composite keys`() {
        val checkpoints = listOf(
            ConditionSummary(id = "trend", name = "Trend 15m", currentValue = "OK", targetValue = "OK", status = "PASSED"),
            ConditionSummary(id = "trend", name = "Trend 1h", currentValue = "OK", targetValue = "OK", status = "PASSED")
        )

        val keys = checkpoints.mapIndexed { index, checkpoint -> generateCheckpointKey(index, checkpoint) }

        assertEquals(2, keys.toSet().size)
        assertEquals("trend_0", keys[0])
        assertEquals("trend_1", keys[1])
    }

    @Test
    fun `blank checkpoint IDs with duplicate names should produce guaranteed unique composite keys`() {
        val checkpoints = listOf(
            ConditionSummary(id = "", name = "EMA Confirmation", currentValue = "PASS", targetValue = "PASS", status = "PASSED"),
            ConditionSummary(id = "", name = "EMA Confirmation", currentValue = "PASS", targetValue = "PASS", status = "PASSED")
        )

        val keys = checkpoints.mapIndexed { index, checkpoint -> generateCheckpointKey(index, checkpoint) }

        assertEquals(2, keys.toSet().size)
        assertEquals("EMA Confirmation_0", keys[0])
        assertEquals("EMA Confirmation_1", keys[1])
    }

    @Test
    fun `BUDGET_INSUFFICIENT_AT_CURRENT_PRICE displays exact trade skipped message`() {
        val message = resolveStrategyScoreCardStatusText(
            qualificationStatus = "BLOCKED_BY_EXISTING_GATE",
            suppressionReason = "BUDGET_INSUFFICIENT_AT_CURRENT_PRICE",
            signalType = "BUY"
        )
        assertEquals("TRADE SKIPPED: Budget insufficient at current market price.", message)
    }

    @Test
    fun `INSUFFICIENT_BUDGET and BELOW_MIN_NOTIONAL also display exact trade skipped message`() {
        val msg1 = resolveStrategyScoreCardStatusText(
            qualificationStatus = "BLOCKED_BY_EXISTING_GATE",
            suppressionReason = "INSUFFICIENT_BUDGET",
            signalType = "BUY"
        )
        assertEquals("TRADE SKIPPED: Budget insufficient at current market price.", msg1)

        val msg2 = resolveStrategyScoreCardStatusText(
            qualificationStatus = "BLOCKED_BY_EXISTING_GATE",
            suppressionReason = "BELOW_MIN_NOTIONAL",
            signalType = "SELL"
        )
        assertEquals("TRADE SKIPPED: Budget insufficient at current market price.", msg2)
    }

    @Test
    fun `TICKER_UNAVAILABLE is kept distinct and does not falsely claim insufficient budget`() {
        val message = resolveStrategyScoreCardStatusText(
            qualificationStatus = "BLOCKED_BY_EXISTING_GATE",
            suppressionReason = "TICKER_UNAVAILABLE",
            signalType = "BUY"
        )
        assertEquals("ENTRY QUALIFICATION: BLOCKED (TICKER_UNAVAILABLE)", message)
        assertNotEquals("TRADE SKIPPED: Budget insufficient at current market price.", message)
    }

    @Test
    fun `qualified strategies display qualification status with signal type`() {
        val msgBuy = resolveStrategyScoreCardStatusText(
            qualificationStatus = "TRADE_QUALIFIED",
            suppressionReason = null,
            signalType = "BUY"
        )
        assertEquals("ENTRY QUALIFICATION: QUALIFIED (BUY)", msgBuy)

        val msgSell = resolveStrategyScoreCardStatusText(
            qualificationStatus = "TRADE_ALERT_CREATED",
            suppressionReason = null,
            signalType = "SELL"
        )
        assertEquals("ENTRY QUALIFICATION: QUALIFIED (SELL)", msgSell)
    }

    // ========================================================================
    // CONSOLIDATED FROM TechnicalAnalysisActivationFixTest (9 Tests)
    // ========================================================================

    @Test
    fun `ActivationFix Test A - USE THIS STRATEGY is enabled and dispatches 1 activation request while preview is loading`() = runTest {
        val botRepo = ActivationRecordingBotRepository()
        val sessionRepo = createMockSessionRepository("Breakout")
        val viewModel = createActivationViewModel(
            sessionRepository = sessionRepo,
            botRepository = botRepo
        )

        val isActivating = viewModel.isActivating.value
        val isEnabledDuringPreviewLoading = isUseThisStrategyButtonEnabled(isActivating = isActivating)
        assertTrue(
            "USE THIS STRATEGY button MUST be enabled while preview is loading (isLoadingPreview == true)",
            isEnabledDuringPreviewLoading
        )

        var successCallbackFired = false
        val baseConfig = TradeSetupConfig(
            strategyId = "Breakout",
            symbol = "BTCUSDT",
            entryPrice = 50000.0,
            parameters = mapOf("breakoutPeriod" to "20")
        )

        viewModel.activateBot(
            symbol = "BTCUSDT",
            strategy = "Breakout",
            config = baseConfig,
            onSuccess = { successCallbackFired = true }
        )
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("Must dispatch exactly 1 activation request to repository", 1, botRepo.activateCallCount)
        assertEquals("BTCUSDT", botRepo.lastActivatedSymbol)
        assertEquals("Breakout", botRepo.lastActivatedStrategy)
        assertEquals("Breakout", botRepo.lastActivatedConfig?.strategyId)
        assertTrue("onSuccess callback must have been executed", successCallbackFired)
        assertFalse("isActivating must reset to false after completion", viewModel.isActivating.value)
    }

    @Test
    fun `ActivationFix Test B - Activation failure preserves unadulterated error string and makes banner visible`() = runTest {
        val rawErrorMessage = "Bybit API key has expired: signature verification failed (code: 10002)"
        val botRepo = ActivationRecordingBotRepository().apply {
            activateResultProvider = {
                NetworkResult.Error(
                    NetworkError.HttpError(
                        code = 401,
                        message = rawErrorMessage,
                        errorCode = "INVALID_API_KEY"
                    )
                )
            }
        }
        val viewModel = createActivationViewModel(
            botRepository = botRepo
        )

        var successFired = false
        viewModel.activateBot(
            symbol = "ETHUSDT",
            strategy = "Momentum",
            config = null,
            onSuccess = { successFired = true }
        )
        testDispatcher.scheduler.advanceUntilIdle()

        assertFalse("onSuccess must NOT fire on failure", successFired)
        assertFalse("isActivating must be false after failure", viewModel.isActivating.value)

        val collectedError = viewModel.activationError.value
        assertNotNull("activationError must NOT be null", collectedError)
        assertEquals(
            "activationError must contain the exact unadulterated error string from BotRepository",
            rawErrorMessage,
            collectedError
        )

        assertTrue(
            "Activation error banner must be visible in UI when error is present",
            isActivationErrorBannerVisible(collectedError)
        )
    }

    @Test
    fun `ActivationFix Test C - Dismissing error clears activationError and hides banner in UI`() = runTest {
        val botRepo = ActivationRecordingBotRepository().apply {
            activateResultProvider = {
                NetworkResult.Error(NetworkError.HttpError(500, "Server Internal Error", "SERVER_ERROR"))
            }
        }
        val viewModel = createActivationViewModel(
            botRepository = botRepo
        )

        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}
        testDispatcher.scheduler.advanceUntilIdle()
        assertNotNull(viewModel.activationError.value)
        assertTrue(isActivationErrorBannerVisible(viewModel.activationError.value))

        viewModel.clearActivationError()

        assertNull("activationError must be null after dismissal", viewModel.activationError.value)
        assertFalse(
            "Activation error banner must be hidden when activationError is null",
            isActivationErrorBannerVisible(viewModel.activationError.value)
        )
    }

    @Test
    fun `ActivationFix Test D - Retrying activation automatically clears prior error before new request completes`() = runTest {
        val deferredResponse = CompletableDeferred<NetworkResult<Unit>>()
        val botRepo = ActivationRecordingBotRepository().apply {
            activateResultProvider = {
                NetworkResult.Error(NetworkError.HttpError(400, "Initial Failure", "ERROR"))
            }
        }
        val viewModel = createActivationViewModel(
            botRepository = botRepo
        )

        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("Initial Failure", viewModel.activationError.value)

        botRepo.activateResultProvider = { deferredResponse.await() }

        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}

        assertNull("Prior activationError must be automatically cleared on retry invocation", viewModel.activationError.value)
        assertTrue("isActivating must be true during retry in-flight", viewModel.isActivating.value)

        deferredResponse.complete(NetworkResult.Success(Unit))
        testDispatcher.scheduler.advanceUntilIdle()

        assertFalse(viewModel.isActivating.value)
        assertNull("activationError remains null after successful retry", viewModel.activationError.value)
    }

    @Test
    fun `ActivationFix Test E - Rapid duplicate taps do not send duplicate activation requests`() = runTest {
        val deferredResponse = CompletableDeferred<NetworkResult<Unit>>()
        val botRepo = ActivationRecordingBotRepository().apply {
            activateResultProvider = { deferredResponse.await() }
        }
        val viewModel = createActivationViewModel(
            botRepository = botRepo
        )

        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}
        assertTrue("isActivating must be true while request is in-flight", viewModel.isActivating.value)
        testDispatcher.scheduler.runCurrent()
        assertEquals("First tap dispatched exactly 1 request", 1, botRepo.activateCallCount)

        assertFalse(
            "USE THIS STRATEGY button is disabled while isActivating is true",
            isUseThisStrategyButtonEnabled(isActivating = viewModel.isActivating.value)
        )

        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}
        testDispatcher.scheduler.runCurrent()

        assertEquals(
            "Duplicate activation call must be ignored while previous is in-flight",
            1,
            botRepo.activateCallCount
        )

        deferredResponse.complete(NetworkResult.Success(Unit))
        testDispatcher.scheduler.advanceUntilIdle()
        assertFalse(viewModel.isActivating.value)
    }

    @Test
    fun `ActivationFix Test F - DEACTIVATE BOT button enabled behavior is completely unchanged`() {
        assertTrue(
            "DEACTIVATE BOT must be enabled when neither activating nor loading",
            isDeactivateBotButtonEnabled(isActivating = false, isLoading = false)
        )
        assertFalse(
            "DEACTIVATE BOT must remain DISABLED when isLoading is true",
            isDeactivateBotButtonEnabled(isActivating = false, isLoading = true)
        )
        assertFalse(
            "DEACTIVATE BOT must be DISABLED when isActivating is true",
            isDeactivateBotButtonEnabled(isActivating = true, isLoading = false)
        )
        assertFalse(
            "DEACTIVATE BOT must be DISABLED when both isActivating and isLoading are true",
            isDeactivateBotButtonEnabled(isActivating = true, isLoading = true)
        )
    }

    @Test
    fun `ActivationFix Test G - activateBot preserves complete candidate list through to repository without collapse`() {
        val recordingRepo = ActivationRecordingBotRepository()
        val mockSession = createMockSessionRepository("ScalperV2")
        val viewModel = createActivationViewModel(botRepository = recordingRepo, sessionRepository = mockSession)

        val candidateList = listOf("BTCUSDT", "ETHUSDT", "SOLUSDT")
        var onSuccessCalled = false

        viewModel.activateBot(symbols = candidateList, strategy = "ScalperV2", config = null) {
            onSuccessCalled = true
        }
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue("onSuccess must be called", onSuccessCalled)
        assertEquals("Repository must receive exactly ONE activateBot call", 1, recordingRepo.activateCallCount)
        assertEquals("Repository must receive ALL candidate symbols", candidateList, recordingRepo.lastActivatedSymbols)
        assertEquals("Primary symbol must be the first candidate", "BTCUSDT", recordingRepo.lastActivatedSymbol)
        assertEquals("Strategy must be ScalperV2", "ScalperV2", recordingRepo.lastActivatedStrategy)
    }

    @Test
    fun `ActivationFix Test H - activateBot with empty list does NOT call repository and sets activationError`() {
        val recordingRepo = ActivationRecordingBotRepository()
        val mockSession = createMockSessionRepository("ScalperV2")
        val viewModel = createActivationViewModel(botRepository = recordingRepo, sessionRepository = mockSession)

        var onSuccessCalled = false
        viewModel.activateBot(symbols = emptyList(), strategy = "ScalperV2", config = null) {
            onSuccessCalled = true
        }
        testDispatcher.scheduler.advanceUntilIdle()

        assertFalse("onSuccess must NOT be called for empty candidate list", onSuccessCalled)
        assertEquals("Repository must NOT receive any activateBot call", 0, recordingRepo.activateCallCount)
        assertNotNull("activationError must be set", viewModel.activationError.value)
        assertEquals("Cannot activate bot: no eligible candidates available.", viewModel.activationError.value)
    }

    @Test
    fun `ActivationFix Test I - single symbol activateBot delegates to multi-symbol and preserves single symbol list`() {
        val recordingRepo = ActivationRecordingBotRepository()
        val mockSession = createMockSessionRepository("ScalperV2")
        val viewModel = createActivationViewModel(botRepository = recordingRepo, sessionRepository = mockSession)

        var onSuccessCalled = false
        viewModel.activateBot(symbol = "XRPUSDT", strategy = "Momentum", config = null) {
            onSuccessCalled = true
        }
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue("onSuccess must be called", onSuccessCalled)
        assertEquals("Repository must receive exactly ONE activateBot call", 1, recordingRepo.activateCallCount)
        assertEquals("Repository must receive single-element list", listOf("XRPUSDT"), recordingRepo.lastActivatedSymbols)
        assertEquals("Primary symbol must be XRPUSDT", "XRPUSDT", recordingRepo.lastActivatedSymbol)
        assertEquals("Strategy must be Momentum", "Momentum", recordingRepo.lastActivatedStrategy)
    }

    // ========================================================================
    // CONSOLIDATED FROM Stage2_6_ManualTradeRemovalSafetyTest (8 Tests)
    // ========================================================================

    @Test
    fun `ManualTradeRemoval 01 - TechnicalAnalysisViewModel does not expose triggerTradeAlert`() {
        val methodNames = TechnicalAnalysisViewModel::class.java.methods.map { it.name }
        assertFalse(
            "TechnicalAnalysisViewModel must NOT declare or inherit triggerTradeAlert",
            methodNames.contains("triggerTradeAlert")
        )
    }

    @Test
    fun `ManualTradeRemoval 02 - BotRepository interface does not declare triggerAlert or executeMockTrade`() {
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
    fun `ManualTradeRemoval 03 - BotRemoteDataSource interface does not declare triggerAlert or executeMockTrade`() {
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
    fun `ManualTradeRemoval 04 - TradingBotService does not declare triggerAlert or executeMockTrade`() {
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
    fun `ManualTradeRemoval 05 - ApiConstants does not declare BOT_TRIGGER_ALERT or BOT_MOCK_TRADE`() {
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

    @Test
    fun `ManualTradeRemoval 06 - TechnicalAnalysisViewModel preserves autonomous bot activation`() = runTest {
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
            override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
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
    fun `ManualTradeRemoval 07 - TechnicalAnalysisViewModel preserves autonomous bot deactivation`() = runTest {
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
            override suspend fun dismissAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
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
    fun `ManualTradeRemoval 08 - TradeAlertScreen autonomous trade execution remains fully intact`() = runTest {
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

        exchangeVm.executeCurrentTrade()
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("Autonomous alert execution MUST trigger executeTrade API", 1, fakeBotRepo.executeTradeCallCount)
        assertEquals("autonomous_alert_777", fakeBotRepo.lastExecutedAlertId)
        assertTrue("Execution state must transition to Filled", exchangeVm.executionState.value is ExecutionUiState.Filled)
        assertEquals("Alarm cutoff must be triggered", 1, fakeAlertManager.dismissOrExecuteCallCount)

        exchangeVm.stopLiveTicker()
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
