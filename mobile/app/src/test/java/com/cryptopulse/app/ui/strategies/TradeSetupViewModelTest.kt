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
    fun `loadStrategySchema populates default values successfully`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"), createMockExchangeRepository())
        
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals(false, state.isLoading)
        assertEquals(null, state.error)
        assertEquals(4, state.fields.size)
        assertEquals("5.0", state.formValues["stopLoss"])
        assertEquals("1.5", state.formValues["risk"])
        assertEquals("Safe", state.formValues["mode"])
        assertEquals("2.0", state.formValues["takeProfitMultiplier"])
        assertEquals("", state.entryPrice)
        assertEquals(null, state.entryPriceError)
    }

    @Test
    fun `updateFieldValue incremental validation fails on max limit`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"), createMockExchangeRepository())
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.updateFieldValue("stopLoss", "150") // max is 100
        
        val state = viewModel.uiState.value
        assertEquals("150", state.formValues["stopLoss"])
        assertEquals("Max is 100.0", state.formErrors["stopLoss"])
    }

    @Test
    fun `updateFieldValue incremental validation fails on invalid enum`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"), createMockExchangeRepository())
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.updateFieldValue("mode", "SuperAggressive")
        
        val state = viewModel.uiState.value
        assertEquals("SuperAggressive", state.formValues["mode"])
        assertEquals("Invalid option.", state.formErrors["mode"])
    }
    
    @Test
    fun `updateFieldValue clears error when valid`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"), createMockExchangeRepository())
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.updateFieldValue("stopLoss", "150") 
        viewModel.updateFieldValue("stopLoss", "50") 
        
        val state = viewModel.uiState.value
        assertEquals("50", state.formValues["stopLoss"])
        assertEquals(null, state.formErrors["stopLoss"])
    }

    @Test
    fun `buildConfig returns Success when all fields valid`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"), createMockExchangeRepository())
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.setMinNotional(10.0)
        viewModel.updateFieldValue("stopLoss", "20")
        viewModel.updateEntryPrice("50000.0")
        viewModel.updateTradeValueUsdt("100.0")

        val result = viewModel.buildConfig("BTC")
        assertTrue(result is TradeSetupConfigResult.Success)
        val config = (result as TradeSetupConfigResult.Success).config
        assertEquals("test_strat", config.strategyId)
        assertEquals("BTC", config.symbol)
        assertEquals(50000.0, config.entryPrice, 0.001)
        assertEquals(100.0, config.tradeValueUsdt, 0.001)
        assertEquals("20", config.parameters["stopLoss"])
    }

    @Test
    fun `buildConfig returns ValidationFailed when entry price is invalid`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"), createMockExchangeRepository())
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.updateEntryPrice("-5.0")

        val result = viewModel.buildConfig("BTC")
        assertTrue(result is TradeSetupConfigResult.ValidationFailed)
        val errors = (result as TradeSetupConfigResult.ValidationFailed).errors
        assertEquals("Entry price must be a valid positive number.", errors["entryPrice"])
        assertEquals("Entry price must be a valid positive number.", viewModel.uiState.value.entryPriceError)
    }

    @Test
    fun `buildConfig returns ValidationFailed when a required field is empty`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"), createMockExchangeRepository())
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.updateFieldValue("stopLoss", "")
        viewModel.updateEntryPrice("")

        val result = viewModel.buildConfig("BTC")
        assertTrue(result is TradeSetupConfigResult.ValidationFailed)
        val errors = (result as TradeSetupConfigResult.ValidationFailed).errors
        assertEquals("This field is required.", errors["stopLoss"])
        assertEquals("Entry price is required.", errors["entryPrice"])
        
        assertEquals("This field is required.", viewModel.uiState.value.formErrors["stopLoss"])
        assertEquals("Entry price is required.", viewModel.uiState.value.entryPriceError)
    }
}


