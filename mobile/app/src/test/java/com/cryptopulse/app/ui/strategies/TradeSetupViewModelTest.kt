package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.BalanceItem
import com.cryptopulse.app.domain.models.ExchangeStatus
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.domain.repository.ExchangeRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.ui.screens.MarketCandidate
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
class TradeSetupViewModelTest {

    private lateinit var viewModel: TradeSetupViewModel
    private lateinit var sessionRepository: FakeTradeSessionRepository
    private lateinit var exchangeRepository: FakeExchangeRepository
    private val testDispatcher = UnconfinedTestDispatcher()

    private val testCandidate = MarketCandidate(
        symbol = "BTCUSDT",
        pairName = "BTC/USDT",
        minNotional = 10.0,
        minOrderQty = 0.001,
        qtyStep = 0.001,
        tickSize = 0.01,
        minPrice = 1000.0,
        maxPrice = 100000.0,
        maxQty = 100.0,
        currentMarketPrice = 50000.0
    )

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        sessionRepository = FakeTradeSessionRepository()
        exchangeRepository = FakeExchangeRepository()
        viewModel = TradeSetupViewModel(sessionRepository, exchangeRepository)
    }

    @Test
    fun `setting constraints and valid entry price should update state correctly`() {
        viewModel.setConstraints(testCandidate, "Binance")
        viewModel.updateEntryPrice("50000.00", testCandidate, "Binance")
        
        val state = viewModel.uiState.value
        assertEquals("50000.00", state.entryPrice)
        assertNull(state.entryPriceError)
    }

    @Test
    fun `invalid entry price should show error in state`() {
        val candidateWithStrictTick = testCandidate.copy(tickSize = 0.1)
        viewModel.setConstraints(candidateWithStrictTick, "Binance")

        viewModel.updateEntryPrice("50000.05", candidateWithStrictTick, "Binance") // 2 decimals
        
        val state = viewModel.uiState.value
        assertNotNull("Should have an error for tick size violation", state.entryPriceError)
    }

    @Test
    fun `validateAndConfirmTrade should persist to repository on success and enforce atomicity`() = runTest {
        viewModel.setConstraints(testCandidate, "Binance")
        viewModel.updateEntryPrice("50000.00", testCandidate, "Binance")
        
        exchangeRepository.mockBalances = listOf(BalanceItem("USDT", 1000.0, 0.0, total = 1000.0))
        
        val result = viewModel.validateAndConfirmTrade("strat_123", testCandidate, "Binance", 1000.0)
        
        assertTrue(result is TradeSetupConfigResult.Success)
        val config = (result as TradeSetupConfigResult.Success).config
        assertEquals(50000.0, config.entryPrice, 0.0)
        assertEquals("BTCUSDT", config.symbol)
        assertEquals("strat_123", config.strategyId)
        
        assertEquals(config, sessionRepository.savedConfig)
    }

    @Test
    fun `validateAndConfirmTrade should fail if balance is insufficient for mapped quote asset`() = runTest {
        viewModel.setConstraints(testCandidate, "Binance")
        viewModel.updateEntryPrice("50000.00", testCandidate, "Binance")
        
        // Mock balance without USDT (mapped from BTC/USDT)
        exchangeRepository.mockBalances = listOf(BalanceItem("BTC", 1.0, 0.0, total = 1.0))
        
        val result = viewModel.validateAndConfirmTrade("strat_123", testCandidate, "Binance", 0.0)
        
        assertTrue(result is TradeSetupConfigResult.ValidationFailed)
        val error = (result as TradeSetupConfigResult.ValidationFailed).errors["balance"]
        assertEquals("Insufficient balance", error)
    }
}

class FakeTradeSessionRepository : TradeSessionRepository {
    override val selectedStrategyId = MutableStateFlow<String?>(null)
    override val tradeSetupConfig = MutableStateFlow<TradeSetupConfig?>(null)
    var savedConfig: TradeSetupConfig? = null

    override fun setStrategyId(id: String) {
        selectedStrategyId.value = id
    }

    override fun setTradeSetupConfig(config: TradeSetupConfig) {
        tradeSetupConfig.value = config
        savedConfig = config
    }

    override fun clearSession() {
        selectedStrategyId.value = null
        tradeSetupConfig.value = null
    }
}

class FakeExchangeRepository : ExchangeRepository {
    var mockBalances: List<BalanceItem> = emptyList()
    
    override suspend fun validateKeys(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun connectExchange(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun getConnectionStatus(): NetworkResult<ExchangeStatus> = NetworkResult.Success(ExchangeStatus(true, "Binance", "mainnet", null))
    override suspend fun getBalances(): NetworkResult<List<BalanceItem>> = NetworkResult.Success(mockBalances)
}
