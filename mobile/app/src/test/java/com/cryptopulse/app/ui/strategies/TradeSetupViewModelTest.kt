package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.ExchangeRepository
import com.cryptopulse.app.domain.repository.StrategyRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TradeSetupViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun createMockRepository(strategy: Strategy?): StrategyRepository {
        return object : StrategyRepository {
            override suspend fun getStrategies(): NetworkResult<List<Strategy>> = NetworkResult.Success(emptyList())
            override suspend fun getStrategyById(id: String): NetworkResult<Strategy?> = NetworkResult.Success(strategy)
        }
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

    private val mockStrategy = Strategy(
        id = "test_strat",
        name = "Test",
        description = "Desc",
        category = StrategyCategory.CUSTOM,
        riskLevel = RiskLevel.LOW,
        schemaVersion = 1,
        requiredParameters = listOf(
            StrategyParameterSchema("stopLoss", "stopLoss", ParameterType.INT, "5.0", true, 1.0, 100.0, null),
            StrategyParameterSchema("risk", "Risk", ParameterType.DOUBLE, "1.5", true, 0.1, 5.0, null),
            StrategyParameterSchema("mode", "Mode", ParameterType.ENUM, "Safe", true, null, null, listOf("Safe", "Aggressive")),
            StrategyParameterSchema("takeProfitMultiplier", "TP", ParameterType.DOUBLE, "2.0", false, null, null, null)
        )
    )

    private fun createMockExchangeRepository(): ExchangeRepository {
        return object : ExchangeRepository {
            override suspend fun validateKeys(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun connectExchange(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getConnectionStatus(): NetworkResult<ExchangeStatus> = NetworkResult.Success(ExchangeStatus(isConnected = true, exchangeName = "binance", environment = "mainnet", region = "global"))
            override suspend fun getBalances(): NetworkResult<List<BalanceItem>> = NetworkResult.Success(
                listOf(BalanceItem(asset = "USDT", free = 1000.0, locked = 0.0, total = 1000.0))
            )
        }
    }

    @Test
    fun `buildConfig returns Success when trade passes validation`() = runTest {
        val viewModel = TradeSetupViewModel(createMockSessionRepository(""), createMockExchangeRepository())
        
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.setConstraints(
            minNotional = 10.0,
            minOrderQty = 0.001,
            qtyStep = 0.001,
            tickSize = 0.1,
            minPrice = 0.1,
            maxPrice = 100000.0,
            maxQty = 100.0
        )
        viewModel.updateEntryPrice("50000.0")
        viewModel.updateTradeValueUsdt("100.0")

        val result = viewModel.buildConfig("BTC")
        assertTrue(result is TradeSetupConfigResult.Success)
        val config = (result as TradeSetupConfigResult.Success).config
        assertEquals(null, config.strategyId)
        assertEquals("BTC", config.symbol)
        assertEquals(50000.0, config.entryPrice, 0.001)
        assertEquals(100.0, config.tradeValueUsdt, 0.001)
    }

    @Test
    fun `buildConfig returns ValidationFailed when entry price is missing`() = runTest {
        val viewModel = TradeSetupViewModel(createMockSessionRepository(""), createMockExchangeRepository())
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.setConstraints(
            minNotional = 10.0,
            minOrderQty = 0.001,
            qtyStep = 0.001,
            tickSize = 0.1,
            minPrice = 0.1,
            maxPrice = 100000.0,
            maxQty = 100.0
        )
        viewModel.updateEntryPrice("")
        viewModel.updateTradeValueUsdt("100.0")

        val result = viewModel.buildConfig("BTC")
        assertTrue(result is TradeSetupConfigResult.ValidationFailed)
        val errors = (result as TradeSetupConfigResult.ValidationFailed).errors
        assertEquals("Entry price is required.", errors["entryPrice"])
        assertEquals("Entry price is required.", viewModel.uiState.value.entryPriceError)
    }

    @Test
    fun `buildConfig fails when required constraint is missing`() = runTest {
        val viewModel = TradeSetupViewModel(createMockSessionRepository(""), createMockExchangeRepository())
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.setConstraints(
            minNotional = null, // Missing constraint
            minOrderQty = 0.001,
            qtyStep = 0.001,
            tickSize = 0.1,
            minPrice = 0.1,
            maxPrice = 100000.0,
            maxQty = 100.0
        )
        viewModel.updateEntryPrice("50000.0")
        viewModel.updateTradeValueUsdt("100.0")

        val result = viewModel.buildConfig("BTC")
        assertTrue(result is TradeSetupConfigResult.ValidationFailed)
        val errors = (result as TradeSetupConfigResult.ValidationFailed).errors
        assertEquals("Trading rules for this pair are currently unavailable from the exchange.", errors["entryPrice"])
    }
}


