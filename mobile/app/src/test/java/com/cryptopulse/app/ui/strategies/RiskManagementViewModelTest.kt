package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.domain.repository.StrategyRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RiskManagementViewModelTest {

    private lateinit var viewModel: RiskManagementViewModel
    private lateinit var sessionRepository: FakeTradeSessionRepositoryForRisk
    private lateinit var strategyRepository: FakeStrategyRepositoryForRisk
    private val testDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        sessionRepository = FakeTradeSessionRepositoryForRisk()
        strategyRepository = FakeStrategyRepositoryForRisk()
        viewModel = RiskManagementViewModel(sessionRepository, strategyRepository)
    }

    @Test
    fun `initialize without existing config sets standard default parameters`() {
        viewModel.initialize()

        val state = viewModel.state.value
        assertEquals(1.0, state.accountRiskPercent, 0.001)
        assertEquals(2.0, state.atrTakeProfitMultiplier, 0.001)
        assertEquals(2.0, state.riskRewardRatio, 0.001) // Deprecated getter compatibility
        assertEquals(1.5, state.atrStopLossMultiplier, 0.001)
    }

    @Test
    fun `initialize with existing session config preserves existing risk parameters`() {
        val existingConfig = TradeSetupConfig(
            strategyId = "ScalperV2",
            symbol = "BTC/USDT",
            entryPrice = 50000.0,
            tradeValueUsdt = 25.0,
            riskParameters = mapOf(
                "accountRiskPercent" to 1.5,
                "atrTakeProfitMultiplier" to 3.2,
                "riskRewardRatio" to 3.2,
                "atrStopLossMultiplier" to 2.1
            )
        )
        sessionRepository.setTradeSetupConfig(existingConfig)

        viewModel.initialize()

        val state = viewModel.state.value
        assertEquals(1.5, state.accountRiskPercent, 0.001)
        assertEquals(3.2, state.atrTakeProfitMultiplier, 0.001)
        assertEquals(3.2, state.riskRewardRatio, 0.001)
        assertEquals(2.1, state.atrStopLossMultiplier, 0.001)
    }

    @Test
    fun `initialize with legacy riskRewardRatio config migrates to atrTakeProfitMultiplier`() {
        val legacyConfig = TradeSetupConfig(
            strategyId = "ScalperV2",
            symbol = "BTC/USDT",
            entryPrice = 50000.0,
            tradeValueUsdt = 25.0,
            riskParameters = mapOf(
                "accountRiskPercent" to 1.5,
                "riskRewardRatio" to 2.8,
                "atrStopLossMultiplier" to 1.8
            )
        )
        sessionRepository.setTradeSetupConfig(legacyConfig)

        viewModel.initialize()

        val state = viewModel.state.value
        assertEquals(2.8, state.atrTakeProfitMultiplier, 0.001)
        assertEquals(1.8, state.atrStopLossMultiplier, 0.001)
    }

    @Test
    fun `updateAtrTakeProfit and legacy updateRiskReward clamp within 1_0 to 5_0`() {
        viewModel.initialize()

        viewModel.updateAtrTakeProfit(0.5)
        assertEquals(1.0, viewModel.state.value.atrTakeProfitMultiplier, 0.001)

        viewModel.updateAtrTakeProfit(6.5)
        assertEquals(5.0, viewModel.state.value.atrTakeProfitMultiplier, 0.001)

        viewModel.updateAtrTakeProfit(2.7)
        assertEquals(2.7, viewModel.state.value.atrTakeProfitMultiplier, 0.001)

        // Test deprecated wrapper
        viewModel.updateRiskReward(3.4)
        assertEquals(3.4, viewModel.state.value.atrTakeProfitMultiplier, 0.001)
        assertEquals(3.4, viewModel.state.value.riskRewardRatio, 0.001)
    }

    @Test
    fun `updateAtrStopLoss clamps within 0_5 to 5_0`() {
        viewModel.initialize()

        viewModel.updateAtrStopLoss(0.1)
        assertEquals(0.5, viewModel.state.value.atrStopLossMultiplier, 0.001)

        viewModel.updateAtrStopLoss(7.2)
        assertEquals(5.0, viewModel.state.value.atrStopLossMultiplier, 0.001)

        viewModel.updateAtrStopLoss(1.8)
        assertEquals(1.8, viewModel.state.value.atrStopLossMultiplier, 0.001)
    }

    @Test
    fun `updateAccountRisk clamps within 0_1 to 5_0`() {
        viewModel.initialize()

        viewModel.updateAccountRisk(0.05)
        assertEquals(0.1, viewModel.state.value.accountRiskPercent, 0.001)

        viewModel.updateAccountRisk(8.0)
        assertEquals(5.0, viewModel.state.value.accountRiskPercent, 0.001)

        viewModel.updateAccountRisk(2.5)
        assertEquals(2.5, viewModel.state.value.accountRiskPercent, 0.001)
    }

    @Test
    fun `getUpdatedConfig persists updated riskParameters into session repository and returns config`() {
        val baseConfig = TradeSetupConfig(
            strategyId = "ScalperV2",
            symbol = "ETH/USDT",
            entryPrice = 3000.0,
            tradeValueUsdt = 50.0
        )
        sessionRepository.setTradeSetupConfig(baseConfig)

        viewModel.initialize()
        viewModel.updateAtrTakeProfit(2.8)
        viewModel.updateAtrStopLoss(1.9)

        val updated = viewModel.getUpdatedConfig()

        assertEquals("ScalperV2", updated.strategyId)
        assertEquals("ETH/USDT", updated.symbol)
        assertEquals(3000.0, updated.entryPrice, 0.001)
        assertEquals(50.0, updated.tradeValueUsdt ?: 0.0, 0.001)

        val params = updated.riskParameters
        assertEquals(4, params.size)
        assertEquals(1.0, params["accountRiskPercent"] ?: 0.0, 0.001)
        assertEquals(2.8, params["atrTakeProfitMultiplier"] ?: 0.0, 0.001)
        assertEquals(2.8, params["riskRewardRatio"] ?: 0.0, 0.001)
        assertEquals(1.9, params["atrStopLossMultiplier"] ?: 0.0, 0.001)

        assertEquals(updated, sessionRepository.tradeSetupConfig.value)
    }
}

class FakeTradeSessionRepositoryForRisk : TradeSessionRepository {
    override val selectedStrategyId = MutableStateFlow<String?>(null)
    override val tradeSetupConfig = MutableStateFlow<TradeSetupConfig?>(null)

    override fun setStrategyId(id: String) {
        selectedStrategyId.value = id
    }

    override fun setTradeSetupConfig(config: TradeSetupConfig) {
        tradeSetupConfig.value = config
    }

    override fun clearSession() {
        selectedStrategyId.value = null
        tradeSetupConfig.value = null
    }
}

class FakeStrategyRepositoryForRisk : StrategyRepository {
    var strategies: List<Strategy> = emptyList()

    override suspend fun getStrategies(): NetworkResult<List<Strategy>> =
        NetworkResult.Success(strategies)

    override suspend fun getStrategyById(id: String): NetworkResult<Strategy?> =
        NetworkResult.Success(strategies.find { it.id == id })

    override fun clearCache() {}
}
