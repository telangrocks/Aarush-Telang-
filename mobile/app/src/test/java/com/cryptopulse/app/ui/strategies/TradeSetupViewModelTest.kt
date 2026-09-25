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
    fun `setting constraints initializes trade amount to 5_00 USDT without pre-populating coin price`() {
        viewModel.setConstraints(testCandidate, "Binance")
        
        val state = viewModel.uiState.value
        assertEquals("5.00", state.tradeAmountUsdt)
        assertEquals("", state.entryPrice)
        assertEquals(com.cryptopulse.app.domain.models.EntryIntent.IMMEDIATE, state.selectedEntryIntent)
        assertNull(state.entryPriceError)
        assertNull(state.tradeAmountError)
    }

    @Test
    fun `candidate without exchange tick or minPrice metadata does NOT produce any error in trade setup`() {
        val candidateWithoutRules = testCandidate.copy(minPrice = null, tickSize = null, minNotional = null)
        viewModel.setConstraints(candidateWithoutRules, "Bybit")
        
        val state = viewModel.uiState.value
        assertNull("Missing exchange metadata should NOT fail Trade Setup capital allocation", state.entryPriceError)
        assertNull(state.tradeAmountError)
        assertEquals("5.00", state.tradeAmountUsdt)
    }

    @Test
    fun `validateAndConfirmTrade should persist to repository on success and enforce atomicity`() = runTest {
        viewModel.setConstraints(testCandidate, "Binance")
        viewModel.updateTradeAmount("15.0", 1000.0)
        
        exchangeRepository.mockBalances = listOf(BalanceItem("USDT", 1000.0, 0.0, total = 1000.0))
        
        val result = viewModel.validateAndConfirmTrade("strat_123", testCandidate, "Binance", 1000.0)
        
        assertTrue(result is TradeSetupConfigResult.Success)
        val config = (result as TradeSetupConfigResult.Success).config
        assertEquals(15.0, config.tradeValueUsdt ?: 0.0, 0.0)
        assertEquals(0.0, config.entryPrice, 0.0) // Dynamic Market Entry: no fixed coin entry price!
        assertEquals("BTCUSDT", config.symbol)
        assertEquals("strat_123", config.strategyId)
        assertEquals(com.cryptopulse.app.domain.models.EntryIntent.IMMEDIATE, config.entryIntent)
        
        assertEquals(config, sessionRepository.savedConfig)
    }

    @Test
    fun `user can configure trade amount in USDT representing capital allocation`() = runTest {
        viewModel.setConstraints(testCandidate, "Bybit")
        viewModel.updateTradeAmount("5.00", 500.0)

        val state = viewModel.uiState.value
        assertEquals("5.00", state.tradeAmountUsdt)
        assertNull(state.tradeAmountError)

        val result = viewModel.validateAndConfirmTrade("Momentum", testCandidate, "Bybit", 500.0)
        assertTrue(result is TradeSetupConfigResult.Success)
        val config = (result as TradeSetupConfigResult.Success).config
        assertEquals(5.0, config.tradeValueUsdt ?: 0.0, 0.0)
        assertEquals(0.0, config.entryPrice, 0.0) // Must NOT represent $5 coin price!
    }

    @Test
    fun `preview market price is preserved in state as reference only and cannot become fixed entry price`() {
        val candidateWithPreview = testCandidate.copy(currentMarketPrice = 1245.46)
        viewModel.setConstraints(candidateWithPreview, "Bybit")

        val state = viewModel.uiState.value
        assertEquals(1245.46, state.previewPrice, 0.001)
        // User trade amount defaults to 5.00 USDT, NOT $1245.46
        assertEquals("5.00", state.tradeAmountUsdt)
    }

    @Test
    fun `validateAndConfirmTrade should fail if balance is insufficient for mapped quote asset`() = runTest {
        viewModel.setConstraints(testCandidate, "Binance")
        
        // Mock balance without USDT (mapped from BTC/USDT)
        exchangeRepository.mockBalances = listOf(BalanceItem("BTC", 1.0, 0.0, total = 1.0))
        
        val result = viewModel.validateAndConfirmTrade("strat_123", testCandidate, "Binance", 0.0)
        
        assertTrue(result is TradeSetupConfigResult.ValidationFailed)
        val error = (result as TradeSetupConfigResult.ValidationFailed).errors["balance"]
        assertEquals("Insufficient balance", error)
    }

    @Test
    fun `validateAndConfirmTrade should fail if trade amount exceeds available balance`() = runTest {
        viewModel.setConstraints(testCandidate, "Bybit")
        viewModel.updateTradeAmount("150.0", 50.0)

        val result = viewModel.validateAndConfirmTrade("Momentum", testCandidate, "Bybit", 50.0)
        assertTrue(result is TradeSetupConfigResult.ValidationFailed)
        val error = (result as TradeSetupConfigResult.ValidationFailed).errors["tradeAmount"]
        assertNotNull(error)
    }

    @Test
    fun `candidate switch preserves user configured trade amount and does not leak coin price`() {
        val penguCandidate = MarketCandidate(
            symbol = "PENGUUSDT",
            pairName = "PENGU/USDT",
            minNotional = 5.0,
            minOrderQty = 1.0,
            qtyStep = 1.0,
            tickSize = 0.000001,
            minPrice = 0.000001,
            maxPrice = 100.0,
            maxQty = 1000000.0,
            currentMarketPrice = 0.009647
        )

        // First configure with BTC candidate
        viewModel.setConstraints(testCandidate, "Bybit")
        viewModel.updateTradeAmount("25.00", 500.0)
        assertEquals("25.00", viewModel.uiState.value.tradeAmountUsdt)
        assertEquals("", viewModel.uiState.value.entryPrice)

        // Now switch context to PENGU
        viewModel.setConstraints(penguCandidate, "Bybit")
        val state = viewModel.uiState.value
        assertEquals("PENGUUSDT", state.currentSymbol)
        assertEquals("25.00", state.tradeAmountUsdt)
        assertEquals("", state.entryPrice)
        assertEquals(0.009647, state.previewPrice, 0.000001)
        assertNull(state.entryPriceError)
        assertNull(state.tradeAmountError)
    }

    @Test
    fun `default entry intent is IMMEDIATE and persists in TradeSetupConfig`() = runTest {
        viewModel.setConstraints(testCandidate, "Bybit")

        exchangeRepository.mockBalances = listOf(BalanceItem("USDT", 1000.0, 0.0, total = 1000.0))

        val result = viewModel.validateAndConfirmTrade("ScalperV2", testCandidate, "Bybit", 1000.0)
        assertTrue(result is TradeSetupConfigResult.Success)

        val config = (result as TradeSetupConfigResult.Success).config
        assertEquals(com.cryptopulse.app.domain.models.EntryIntent.IMMEDIATE, config.entryIntent)
        assertEquals(com.cryptopulse.app.domain.models.EntryIntent.IMMEDIATE, sessionRepository.savedConfig?.entryIntent)
    }

    @Test
    fun `untouched risk settings result in emptyMap in TradeSetupConfig allowing strategy presets`() = runTest {
        viewModel.setConstraints(testCandidate, "Bybit")
        exchangeRepository.mockBalances = listOf(BalanceItem("USDT", 1000.0, 0.0, total = 1000.0))

        val state = viewModel.uiState.value
        assertNull(state.atrTakeProfitMultiplier)
        assertNull(state.riskRewardRatio)
        assertNull(state.atrStopLossMultiplier)

        val result = viewModel.validateAndConfirmTrade("ScalperV2", testCandidate, "Bybit", 1000.0)
        assertTrue(result is TradeSetupConfigResult.Success)

        val config = (result as TradeSetupConfigResult.Success).config
        assertTrue("Untouched risk settings must produce emptyMap to allow strategy presets", config.riskParameters.isEmpty())
    }

    @Test
    fun `customized risk settings populate exact riskParameters in TradeSetupConfig`() = runTest {
        viewModel.setConstraints(testCandidate, "Bybit")
        exchangeRepository.mockBalances = listOf(BalanceItem("USDT", 1000.0, 0.0, total = 1000.0))

        viewModel.updateAtrTakeProfit(2.5)
        viewModel.updateAtrStopLoss(1.8)

        val state = viewModel.uiState.value
        assertEquals(2.5, state.atrTakeProfitMultiplier ?: 0.0, 0.001)
        assertEquals(2.5, state.riskRewardRatio ?: 0.0, 0.001)
        assertEquals(1.8, state.atrStopLossMultiplier ?: 0.0, 0.001)

        val result = viewModel.validateAndConfirmTrade("ScalperV2", testCandidate, "Bybit", 1000.0)
        assertTrue(result is TradeSetupConfigResult.Success)

        val config = (result as TradeSetupConfigResult.Success).config
        assertEquals(3, config.riskParameters.size)
        assertEquals(2.5, config.riskParameters["atrTakeProfitMultiplier"] ?: 0.0, 0.001)
        assertEquals(2.5, config.riskParameters["riskRewardRatio"] ?: 0.0, 0.001)
        assertEquals(1.8, config.riskParameters["atrStopLossMultiplier"] ?: 0.0, 0.001)
    }

    @Test
    fun `updateAtrTakeProfit and updateAtrStopLoss clamp within valid bounds`() {
        viewModel.updateAtrTakeProfit(0.5) // Below 1.0
        assertEquals(1.0, viewModel.uiState.value.atrTakeProfitMultiplier ?: 0.0, 0.001)

        viewModel.updateAtrTakeProfit(6.0) // Above 5.0
        assertEquals(5.0, viewModel.uiState.value.atrTakeProfitMultiplier ?: 0.0, 0.001)

        viewModel.updateRiskReward(3.2) // Legacy method
        assertEquals(3.2, viewModel.uiState.value.atrTakeProfitMultiplier ?: 0.0, 0.001)

        viewModel.updateAtrStopLoss(0.1) // Below 0.5
        assertEquals(0.5, viewModel.uiState.value.atrStopLossMultiplier ?: 0.0, 0.001)

        viewModel.updateAtrStopLoss(10.0) // Above 5.0
        assertEquals(5.0, viewModel.uiState.value.atrStopLossMultiplier ?: 0.0, 0.001)
    }

    @Test
    fun `resetRiskParameters resets risk settings back to null and produces emptyMap`() = runTest {
        viewModel.setConstraints(testCandidate, "Bybit")
        exchangeRepository.mockBalances = listOf(BalanceItem("USDT", 1000.0, 0.0, total = 1000.0))

        viewModel.updateAtrTakeProfit(3.0)
        viewModel.updateAtrStopLoss(2.0)
        assertNotNull(viewModel.uiState.value.atrTakeProfitMultiplier)
        assertNotNull(viewModel.uiState.value.atrStopLossMultiplier)

        viewModel.resetRiskParameters()
        assertNull(viewModel.uiState.value.atrTakeProfitMultiplier)
        assertNull(viewModel.uiState.value.riskRewardRatio)
        assertNull(viewModel.uiState.value.atrStopLossMultiplier)

        val result = viewModel.validateAndConfirmTrade("ScalperV2", testCandidate, "Bybit", 1000.0)
        assertTrue(result is TradeSetupConfigResult.Success)

        val config = (result as TradeSetupConfigResult.Success).config
        assertTrue(config.riskParameters.isEmpty())
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
