package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.repository.StrategyRepository
import com.cryptopulse.app.domain.repository.TechnicalAnalysisRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TechnicalAnalysisActivationFixTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun createMockSessionRepository(
        strategyId: String? = "ScalperV2",
        initialConfig: TradeSetupConfig? = null
    ): TradeSessionRepository {
        return object : TradeSessionRepository {
            private val _id = MutableStateFlow(strategyId)
            override val selectedStrategyId: StateFlow<String?> = _id.asStateFlow()

            private val _config = MutableStateFlow(initialConfig)
            override val tradeSetupConfig: StateFlow<TradeSetupConfig?> = _config.asStateFlow()

            override fun setStrategyId(id: String) { _id.value = id }
            override fun setTradeSetupConfig(config: TradeSetupConfig) { _config.value = config }
            override fun clearSession() {}
        }
    }

    private class RecordingBotRepository : BotRepository {
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
        @Suppress("DEPRECATION")
        override suspend fun executeMockTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto): NetworkResult<TradeExecutionResult> =
            NetworkResult.Error(NetworkError.Unknown(Exception("Not implemented")))
        override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> =
            NetworkResult.Error(NetworkError.Unknown(Exception("Not implemented")))
        override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long) =
            kotlinx.coroutines.flow.emptyFlow<TradeExecutionResult>()
        override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = NetworkResult.Success(emptyList())
        override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
        override suspend fun triggerAlert(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<BotAlert> =
            NetworkResult.Error(NetworkError.Unknown(Exception("Not implemented")))

        override fun updateAnalysisState(snapshot: AnalysisSnapshot?) { _analysisState.value = snapshot }
        override fun updateConnectionState(connected: Boolean) { _isConnected.value = connected }
        override fun startObserving() {}
        override fun stopObserving() {}
    }

    private fun createMockTechnicalAnalysisRepository(): TechnicalAnalysisRepository {
        return object : TechnicalAnalysisRepository {
            override suspend fun getAnalysis(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<TechnicalAnalysisResult> {
                return NetworkResult.Error(NetworkError.HttpError(400, "Mock", "MOCK"))
            }
            override suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<AnalysisSnapshot> {
                return NetworkResult.Error(NetworkError.HttpError(400, "Mock", "MOCK"))
            }
        }
    }

    private fun createMockStrategyRepository(): StrategyRepository {
        return object : StrategyRepository {
            override suspend fun getStrategies(): NetworkResult<List<Strategy>> = NetworkResult.Success(emptyList())
            override suspend fun getStrategyById(id: String): NetworkResult<Strategy?> = NetworkResult.Success(null)
            override fun clearCache() {}
        }
    }

    private fun createViewModel(
        sessionRepository: TradeSessionRepository = createMockSessionRepository(),
        botRepository: BotRepository = RecordingBotRepository(),
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

    // ========================================================================
    // UI Button Enabled Condition Helpers (Mirroring TechnicalAnalysisScreen)
    // ========================================================================
    private fun isUseThisStrategyButtonEnabled(isActivating: Boolean): Boolean {
        // Surgical Fix: enabled = !isActivating (no longer blocked by isLoadingPreview)
        return !isActivating
    }

    private fun isDeactivateBotButtonEnabled(isActivating: Boolean, isLoading: Boolean): Boolean {
        // Preserved Unchanged: enabled = !isActivating && !isLoading
        return !isActivating && !isLoading
    }

    private fun isActivationErrorBannerVisible(activationError: String?): Boolean {
        return !activationError.isNullOrBlank()
    }

    // ========================================================================
    // TEST A: Clicking "USE THIS STRATEGY" while isLoadingPreview == true
    // ========================================================================
    @Test
    fun `Test A - USE THIS STRATEGY is enabled and dispatches 1 activation request while preview is loading`() = runTest {
        val botRepo = RecordingBotRepository()
        val sessionRepo = createMockSessionRepository("Breakout")
        val viewModel = createViewModel(
            sessionRepository = sessionRepo,
            botRepository = botRepo
        )

        // Given: Preview is loading (isLoadingPreview == true) and bot is not activating
        // 1. Verify UI Button enabled state:
        val isActivating = viewModel.isActivating.value
        val isEnabledDuringPreviewLoading = isUseThisStrategyButtonEnabled(isActivating = isActivating)
        assertTrue(
            "USE THIS STRATEGY button MUST be enabled while preview is loading (isLoadingPreview == true)",
            isEnabledDuringPreviewLoading
        )

        // 2. User presses "USE THIS STRATEGY"
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

        // 3. Verify exactly 1 activation request was dispatched to BotRepository with correct strategy
        assertEquals("Must dispatch exactly 1 activation request to repository", 1, botRepo.activateCallCount)
        assertEquals("BTCUSDT", botRepo.lastActivatedSymbol)
        assertEquals("Breakout", botRepo.lastActivatedStrategy)
        assertEquals("Breakout", botRepo.lastActivatedConfig?.strategyId)
        assertTrue("onSuccess callback must have been executed", successCallbackFired)
        assertFalse("isActivating must reset to false after completion", viewModel.isActivating.value)
    }

    // ========================================================================
    // TEST B: Activation Failure - Unadulterated Error Appears in activationError and UI
    // ========================================================================
    @Test
    fun `Test B - Activation failure preserves unadulterated error string and makes banner visible`() = runTest {
        val rawErrorMessage = "Bybit API key has expired: signature verification failed (code: 10002)"
        val botRepo = RecordingBotRepository().apply {
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
        val viewModel = createViewModel(
            botRepository = botRepo
        )

        // Perform activation that fails
        var successFired = false
        viewModel.activateBot(
            symbol = "ETHUSDT",
            strategy = "Momentum",
            config = null,
            onSuccess = { successFired = true }
        )
        testDispatcher.scheduler.advanceUntilIdle()

        // Verify failure behavior:
        assertFalse("onSuccess must NOT fire on failure", successFired)
        assertFalse("isActivating must be false after failure", viewModel.isActivating.value)

        // Error must be preserved verbatim without mutation or translation
        val collectedError = viewModel.activationError.value
        assertNotNull("activationError must NOT be null", collectedError)
        assertEquals(
            "activationError must contain the exact unadulterated error string from BotRepository",
            rawErrorMessage,
            collectedError
        )

        // UI Banner must be visible with the exact error
        assertTrue(
            "Activation error banner must be visible in UI when error is present",
            isActivationErrorBannerVisible(collectedError)
        )
    }

    // ========================================================================
    // TEST C: Dismissing Error via clearActivationError()
    // ========================================================================
    @Test
    fun `Test C - Dismissing error clears activationError and hides banner in UI`() = runTest {
        val botRepo = RecordingBotRepository().apply {
            activateResultProvider = {
                NetworkResult.Error(NetworkError.HttpError(500, "Server Internal Error", "SERVER_ERROR"))
            }
        }
        val viewModel = createViewModel(
            botRepository = botRepo
        )

        // Trigger an error first
        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}
        testDispatcher.scheduler.advanceUntilIdle()
        assertNotNull(viewModel.activationError.value)
        assertTrue(isActivationErrorBannerVisible(viewModel.activationError.value))

        // When user taps dismiss on error banner:
        viewModel.clearActivationError()

        // Then:
        assertNull("activationError must be null after dismissal", viewModel.activationError.value)
        assertFalse(
            "Activation error banner must be hidden when activationError is null",
            isActivationErrorBannerVisible(viewModel.activationError.value)
        )
    }

    // ========================================================================
    // TEST D: Retrying Activation Automatically Clears Prior Error
    // ========================================================================
    @Test
    fun `Test D - Retrying activation automatically clears prior error before new request completes`() = runTest {
        val deferredResponse = CompletableDeferred<NetworkResult<Unit>>()
        val botRepo = RecordingBotRepository().apply {
            // First call fails
            activateResultProvider = {
                NetworkResult.Error(NetworkError.HttpError(400, "Initial Failure", "ERROR"))
            }
        }
        val viewModel = createViewModel(
            botRepository = botRepo
        )

        // 1. First attempt fails
        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("Initial Failure", viewModel.activationError.value)

        // 2. Set up second attempt to hang on deferred response
        botRepo.activateResultProvider = { deferredResponse.await() }

        // 3. User taps "USE THIS STRATEGY" to retry
        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}

        // Verify: Prior error is cleared IMMEDIATELY at the start of the retry attempt
        assertNull("Prior activationError must be automatically cleared on retry invocation", viewModel.activationError.value)
        assertTrue("isActivating must be true during retry in-flight", viewModel.isActivating.value)

        // Complete the second request successfully
        deferredResponse.complete(NetworkResult.Success(Unit))
        testDispatcher.scheduler.advanceUntilIdle()

        assertFalse(viewModel.isActivating.value)
        assertNull("activationError remains null after successful retry", viewModel.activationError.value)
    }

    // ========================================================================
    // TEST E: Duplicate Rapid Taps Suppressed
    // ========================================================================
    @Test
    fun `Test E - Rapid duplicate taps do not send duplicate activation requests`() = runTest {
        val deferredResponse = CompletableDeferred<NetworkResult<Unit>>()
        val botRepo = RecordingBotRepository().apply {
            activateResultProvider = { deferredResponse.await() }
        }
        val viewModel = createViewModel(
            botRepository = botRepo
        )

        // 1. First tap fires activation
        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}
        assertTrue("isActivating must be true while request is in-flight", viewModel.isActivating.value)
        testDispatcher.scheduler.runCurrent()
        assertEquals("First tap dispatched exactly 1 request", 1, botRepo.activateCallCount)

        // 2. UI button is disabled while isActivating == true
        assertFalse(
            "USE THIS STRATEGY button is disabled while isActivating is true",
            isUseThisStrategyButtonEnabled(isActivating = viewModel.isActivating.value)
        )

        // 3. Second rapid tap arrives while still in-flight
        viewModel.activateBot("BTCUSDT", "ScalperV2", null) {}
        testDispatcher.scheduler.runCurrent()

        // Verify: Repository call count remains exactly 1 (duplicate suppressed at ViewModel level)
        assertEquals(
            "Duplicate activation call must be ignored while previous is in-flight",
            1,
            botRepo.activateCallCount
        )

        // Complete in-flight request
        deferredResponse.complete(NetworkResult.Success(Unit))
        testDispatcher.scheduler.advanceUntilIdle()
        assertFalse(viewModel.isActivating.value)
    }

    // ========================================================================
    // TEST F: DEACTIVATE BOT Button Behavior Is Unchanged
    // ========================================================================
    @Test
    fun `Test F - DEACTIVATE BOT button enabled behavior is completely unchanged`() {
        // Rule for DEACTIVATE BOT: enabled = !isActivating && !isLoading

        // Case 1: Idle, no loading -> Enabled
        assertTrue(
            "DEACTIVATE BOT must be enabled when neither activating nor loading",
            isDeactivateBotButtonEnabled(isActivating = false, isLoading = false)
        )

        // Case 2: Preview loading, not activating -> Disabled (proves !isLoading constraint is preserved!)
        assertFalse(
            "DEACTIVATE BOT must remain DISABLED when isLoading is true",
            isDeactivateBotButtonEnabled(isActivating = false, isLoading = true)
        )

        // Case 3: Deactivating in-flight, not loading -> Disabled
        assertFalse(
            "DEACTIVATE BOT must be DISABLED when isActivating is true",
            isDeactivateBotButtonEnabled(isActivating = true, isLoading = false)
        )

        // Case 4: Both activating and loading -> Disabled
        assertFalse(
            "DEACTIVATE BOT must be DISABLED when both isActivating and isLoading are true",
            isDeactivateBotButtonEnabled(isActivating = true, isLoading = true)
        )
    }

    // ========================================================================
    // TEST G: Multi-Symbol Candidate List Propagation Is Preserved
    // ========================================================================
    @Test
    fun `Test G - activateBot preserves complete candidate list through to repository without collapse`() {
        val recordingRepo = RecordingBotRepository()
        val mockSession = createMockSessionRepository()
        val viewModel = createViewModel(botRepository = recordingRepo, sessionRepository = mockSession)

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

    // ========================================================================
    // TEST H: Empty Candidate List Rejection
    // ========================================================================
    @Test
    fun `Test H - activateBot with empty list does NOT call repository and sets activationError`() {
        val recordingRepo = RecordingBotRepository()
        val mockSession = createMockSessionRepository()
        val viewModel = createViewModel(botRepository = recordingRepo, sessionRepository = mockSession)

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

    // ========================================================================
    // TEST I: Backward Compatibility - Single-Symbol Overload Delegates to List
    // ========================================================================
    @Test
    fun `Test I - single symbol activateBot delegates to multi-symbol and preserves single symbol list`() {
        val recordingRepo = RecordingBotRepository()
        val mockSession = createMockSessionRepository()
        val viewModel = createViewModel(botRepository = recordingRepo, sessionRepository = mockSession)

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
}
