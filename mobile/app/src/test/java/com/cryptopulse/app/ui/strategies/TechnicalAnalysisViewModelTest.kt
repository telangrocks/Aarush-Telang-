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
            override suspend fun executeTrade(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun executeMockTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
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
}
