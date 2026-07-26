package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.data.api.*
import com.cryptopulse.app.data.repository.TradeSessionRepository
import com.cryptopulse.app.domain.models.TradeSetupConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.Response

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

    private fun createMockTradingBotService(shouldSucceed: Boolean = true): TradingBotService {
        return object : TradingBotService {
            override suspend fun activate(request: ActivateBotRequest): Response<ActivateBotResponse> {
                return if (shouldSucceed) {
                    Response.success(ActivateBotResponse(success = true, message = "Bot activated."))
                } else {
                    Response.error(400, okhttp3.ResponseBody.create(null, "Failed"))
                }
            }

            override suspend fun deactivate(): Response<DeactivateBotResponse> {
                return Response.success(DeactivateBotResponse(success = true, message = "Deactivated"))
            }

            override suspend fun getStatus(): Response<BotStatusResponse> {
                return Response.success(BotStatusResponse(isActive = true, coinId = "BTC", strategy = "scalper-v2"))
            }

            override suspend fun getAnalysisStatus(): Response<com.cryptopulse.app.domain.models.AnalysisSnapshot> {
                return Response.error(404, okhttp3.ResponseBody.create(null, "Not found"))
            }

            override suspend fun acknowledgeAlert(request: Map<String, String>): Response<Map<String, Any>> {
                return Response.success(emptyMap())
            }

            override suspend fun executeTrade(): Response<Map<String, Any>> {
                return Response.success(mapOf("success" to true))
            }
        }
    }

    @Test
    fun `activateBot performs explicit user activation handshake and invokes onSuccess`() = runTest {
        val viewModel = TechnicalAnalysisViewModel(
            createMockSessionRepository("scalper-v2"),
            createMockTradingBotService(shouldSucceed = true)
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
            createMockTradingBotService(shouldSucceed = true)
        )

        var isStoppedInvoked = false
        viewModel.stopBot {
            isStoppedInvoked = true
        }

        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(isStoppedInvoked)
    }
}
