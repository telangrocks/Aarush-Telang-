package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.data.repository.StrategyRepository
import com.cryptopulse.app.data.repository.TradeSessionRepository
import com.cryptopulse.app.domain.models.ParameterType
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.StrategyParameterSchema
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
            override suspend fun getStrategies(): Result<List<Strategy>> = Result.success(emptyList())
            override suspend fun getStrategyById(id: String): Result<Strategy?> = Result.success(strategy)
        }
    }

    private fun createMockSessionRepository(strategyId: String?): TradeSessionRepository {
        return object : TradeSessionRepository {
            private val _id = MutableStateFlow(strategyId)
            override val selectedStrategyId: StateFlow<String?> = _id.asStateFlow()
            
            private val _config = MutableStateFlow<com.cryptopulse.app.domain.models.TradeSetupConfig?>(null)
            override val tradeSetupConfig: StateFlow<com.cryptopulse.app.domain.models.TradeSetupConfig?> = _config.asStateFlow()
            
            override fun setStrategyId(id: String) { _id.value = id }
            override fun setTradeSetupConfig(config: com.cryptopulse.app.domain.models.TradeSetupConfig) { _config.value = config }
            override fun clearSession() {}
        }
    }

    private val mockStrategy = Strategy(
        id = "test_strat",
        name = "Test",
        description = "Desc",
        categories = emptyList(),
        requiredParameters = listOf(
            StrategyParameterSchema("leverage", "Leverage", ParameterType.INT, "10", true, 1.0, 100.0, null),
            StrategyParameterSchema("risk", "Risk", ParameterType.DOUBLE, "1.5", true, 0.1, 5.0, null),
            StrategyParameterSchema("mode", "Mode", ParameterType.ENUM, "Safe", true, null, null, listOf("Safe", "Aggressive")),
            StrategyParameterSchema("trailing_stop", "TS", ParameterType.BOOLEAN, "false", false, null, null, null)
        )
    )

    @Test
    fun `loadStrategySchema populates default values successfully`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"))
        
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals(false, state.isLoading)
        assertEquals(null, state.error)
        assertEquals(4, state.fields.size)
        assertEquals("10", state.formValues["leverage"])
        assertEquals("1.5", state.formValues["risk"])
        assertEquals("Safe", state.formValues["mode"])
        assertEquals("false", state.formValues["trailing_stop"])
    }

    @Test
    fun `updateFieldValue incremental validation fails on max limit`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"))
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.updateFieldValue("leverage", "150") // max is 100
        
        val state = viewModel.uiState.value
        assertEquals("150", state.formValues["leverage"])
        assertEquals("Max is 100.0", state.formErrors["leverage"])
    }

    @Test
    fun `updateFieldValue incremental validation fails on invalid enum`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"))
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.updateFieldValue("mode", "SuperAggressive")
        
        val state = viewModel.uiState.value
        assertEquals("SuperAggressive", state.formValues["mode"])
        assertEquals("Invalid option.", state.formErrors["mode"])
    }
    
    @Test
    fun `updateFieldValue clears error when valid`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"))
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.updateFieldValue("leverage", "150") 
        viewModel.updateFieldValue("leverage", "50") 
        
        val state = viewModel.uiState.value
        assertEquals("50", state.formValues["leverage"])
        assertEquals(null, state.formErrors["leverage"])
    }

    @Test
    fun `buildConfig returns Success when all fields valid`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"))
        testDispatcher.scheduler.advanceUntilIdle()

        // Change from default to valid
        viewModel.updateFieldValue("leverage", "20")

        val result = viewModel.buildConfig("BTC")
        assertTrue(result is TradeSetupConfigResult.Success)
        val config = (result as TradeSetupConfigResult.Success).config
        assertEquals("test_strat", config.strategyId)
        assertEquals("BTC", config.symbol)
        assertEquals("20", config.parameters["leverage"])
    }

    @Test
    fun `buildConfig returns ValidationFailed when a required field is empty`() = runTest {
        val viewModel = TradeSetupViewModel(createMockRepository(mockStrategy), createMockSessionRepository("test_strat"))
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.updateFieldValue("leverage", "") // required

        val result = viewModel.buildConfig("BTC")
        assertTrue(result is TradeSetupConfigResult.ValidationFailed)
        val errors = (result as TradeSetupConfigResult.ValidationFailed).errors
        assertEquals("This field is required.", errors["leverage"])
        
        // Also check UI state got updated with the error
        assertEquals("This field is required.", viewModel.uiState.value.formErrors["leverage"])
    }
}
