package com.cryptopulse.app.ui.auth

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.network.safeApiCall
import com.cryptopulse.app.data.api.dto.market.response.KlineDto
import com.cryptopulse.app.data.api.dto.market.response.MarketCandidateDto
import com.cryptopulse.app.data.api.dto.market.response.TickerResponseDto
import com.cryptopulse.app.data.datasource.remote.market.MarketRemoteDataSource
import com.cryptopulse.app.data.repository.MarketRepositoryImpl
import com.cryptopulse.app.domain.models.BalanceItem
import com.cryptopulse.app.domain.models.ExchangeStatus
import com.cryptopulse.app.domain.repository.ExchangeRepository
import com.cryptopulse.app.core.error.NetworkError
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.Headers
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.Response

@OptIn(ExperimentalCoroutinesApi::class)
class ExchangeBalanceTest {

    private lateinit var viewModel: ExchangeViewModel
    private lateinit var exchangeRepository: FakeExchangeRepository
    private lateinit var marketRepository: FakeMarketRepositoryMinimal
    private lateinit var testDispatcher: kotlinx.coroutines.test.TestDispatcher

    @Before
    fun setup() {
        testDispatcher = UnconfinedTestDispatcher()
        Dispatchers.setMain(testDispatcher)
        exchangeRepository = FakeExchangeRepository()
        marketRepository = FakeMarketRepositoryMinimal()
        
        // Use a minimal approach - we only care about fetchBalances calling exchangeRepository.getBalances()
        // and updating _balances state.
        viewModel = ExchangeViewModel(
            appContext = FakeContextMinimal(),
            exchangeRepository = exchangeRepository,
            marketRepository = marketRepository,
            technicalAnalysisRepository = FakeTechnicalAnalysisRepositoryMinimal(),
            botRepository = FakeBotRepositoryMinimal(),
            fcmRepository = FakeFcmRepositoryMinimal(),
            tokenManager = FakeTokenManagerMinimal(),
            exchangeConnectionManager = FakeExchangeConnectionManagerMinimal(),
            sessionRepository = FakeTradeSessionRepositoryMinimal(),
            tradeAlertManager = FakeTradeAlertManagerMinimal()
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `fetchBalances success should update balances state`() {
        val mockBalances = listOf(
            BalanceItem(asset = "BTC", free = 1.0, locked = 0.0, total = 1.0),
            BalanceItem(asset = "USDT", free = 1000.0, locked = 0.0, total = 1000.0)
        )
        exchangeRepository.balancesResult = NetworkResult.Success(mockBalances)

        viewModel.fetchBalances()

        assertEquals(mockBalances, viewModel.balances.value)
        assertNull(viewModel.balancesError.value)
    }

    @Test
    fun `fetchBalances error should update balancesError state`() {
        val errorMessage = "API error"
        exchangeRepository.balancesResult = NetworkResult.Error(NetworkError.Unknown(Exception(errorMessage)))

        viewModel.fetchBalances()

        assertEquals(errorMessage, viewModel.balancesError.value)
        assertNull(viewModel.balances.value)
    }

    @Test
    fun `fetchBalances within TTL skips network fetch when force is false`() {
        var currentTime = 100_000L
        viewModel.clock = { currentTime }

        val mockBalances = listOf(
            BalanceItem(asset = "USDT", free = 500.0, locked = 0.0, total = 500.0)
        )
        exchangeRepository.balancesResult = NetworkResult.Success(mockBalances)

        // First call triggers network
        viewModel.fetchBalances()
        assertEquals(1, exchangeRepository.fetchBalancesCallCount)
        assertEquals(mockBalances, viewModel.balances.value)

        // Advance clock by 5s (< 15s TTL)
        currentTime += 5_000L
        viewModel.fetchBalances(force = false)
        // Count remains 1 (skipped)
        assertEquals(1, exchangeRepository.fetchBalancesCallCount)

        // Advance clock by 11s (> 15s TTL)
        currentTime += 11_000L
        viewModel.fetchBalances(force = false)
        assertEquals(2, exchangeRepository.fetchBalancesCallCount)
    }

    @Test
    fun `fetchBalances with force=true bypasses TTL and performs network fetch`() {
        var currentTime = 100_000L
        viewModel.clock = { currentTime }

        val mockBalances = listOf(
            BalanceItem(asset = "USDT", free = 500.0, locked = 0.0, total = 500.0)
        )
        exchangeRepository.balancesResult = NetworkResult.Success(mockBalances)

        viewModel.fetchBalances()
        assertEquals(1, exchangeRepository.fetchBalancesCallCount)

        // Advance clock by only 1s, but call with force = true
        currentTime += 1_000L
        viewModel.fetchBalances(force = true)
        assertEquals(2, exchangeRepository.fetchBalancesCallCount)
    }

    @Test
    fun `fetchBalances failure sets isBalanceStale to true and clears balances`() {
        val initialBalances = listOf(
            BalanceItem(asset = "USDT", free = 500.0, locked = 0.0, total = 500.0)
        )
        exchangeRepository.balancesResult = NetworkResult.Success(initialBalances)
        viewModel.fetchBalances()
        assertFalse(viewModel.isBalanceStale.value)
        assertEquals(initialBalances, viewModel.balances.value)

        // Now failure happens
        exchangeRepository.balancesResult = NetworkResult.Error(NetworkError.Unknown(Exception("Network error")))
        viewModel.fetchBalances(force = true)

        assertTrue(viewModel.isBalanceStale.value)
        assertNull(viewModel.balances.value)
        assertEquals("Network error", viewModel.balancesError.value)
    }

    @Test
    fun `fetchMarketCandidates distinguishes backend NO_ELIGIBLE_MARKETS from NO_TECHNICAL_OPPORTUNITIES without hardcoded dollar thresholds`() {
        // 1. Even with a $4 budget (< $5), if backend reports NO_TECHNICAL_OPPORTUNITIES, UI state does NOT claim budget is insufficient
        marketRepository.candidatesResult = NetworkResult.Success(
            emptyList(),
            headers = mapOf("X-Empty-Reason" to "NO_TECHNICAL_OPPORTUNITIES", "X-Eligible-Market-Count" to "3")
        )
        viewModel.fetchMarketCandidates(4.0)
        val stateTechEmpty = viewModel.marketDataState.value as MarketDataUiState.Empty
        assertEquals("NO_TECHNICAL_OPPORTUNITIES", stateTechEmpty.emptyReason)
        assertTrue(stateTechEmpty.message.contains("strategy criteria"))
        assertFalse(stateTechEmpty.message.contains("Please increase your budget"))

        // 2. When backend authoritatively reports NO_ELIGIBLE_MARKETS, UI state reports budget ineligibility
        marketRepository.candidatesResult = NetworkResult.Success(
            emptyList(),
            headers = mapOf("X-Empty-Reason" to "NO_ELIGIBLE_MARKETS", "X-Eligible-Market-Count" to "0")
        )
        viewModel.fetchMarketCandidates(4.0)
        val stateBudgetEmpty = viewModel.marketDataState.value as MarketDataUiState.Empty
        assertEquals("NO_ELIGIBLE_MARKETS", stateBudgetEmpty.emptyReason)
        assertTrue(stateBudgetEmpty.message.contains("Please increase your budget"))

        // 3. When backend/network fails, UI state transitions to Error (never Empty/budget message)
        marketRepository.candidatesResult = NetworkResult.Error(
            NetworkError.HttpError(503, "Market data temporarily degraded")
        )
        viewModel.fetchMarketCandidates(5000.0)
        assertTrue(viewModel.marketDataState.value is MarketDataUiState.Error)
    }

    @Test
    fun `safeApiCall and MarketRepositoryImpl propagate X-Empty-Reason and X-Eligible-Market-Count headers to ExchangeViewModel`() = runTest {
        val testDispatchers = object : DispatcherProvider {
            override val main: CoroutineDispatcher = testDispatcher
            override val io: CoroutineDispatcher = testDispatcher
            override val default: CoroutineDispatcher = testDispatcher
            override val unconfined: CoroutineDispatcher = testDispatcher
        }

        var simulatedHeaders: Headers = Headers.headersOf(
            "X-Empty-Reason", "NO_ELIGIBLE_MARKETS",
            "X-Eligible-Market-Count", "0"
        )

        val remoteDataSource = object : MarketRemoteDataSource {
            override suspend fun getMarketCandidates(budget: Double): NetworkResult<List<MarketCandidateDto>> =
                safeApiCall {
                    Response.success(emptyList<MarketCandidateDto>(), simulatedHeaders)
                }

            override suspend fun getKlines(symbol: String, interval: String, limit: Int): NetworkResult<List<KlineDto>> =
                NetworkResult.Success(emptyList())

            override suspend fun getTicker(symbol: String): NetworkResult<TickerResponseDto> =
                NetworkResult.Error(NetworkError.Unknown(Exception("unused")))
        }

        val realMarketRepository = MarketRepositoryImpl(remoteDataSource, testDispatchers)

        // 1. Verify safeApiCall + MarketRepositoryImpl extract and preserve headers for NO_ELIGIBLE_MARKETS
        val repoResultBudget = realMarketRepository.getCandidates(4.0) as NetworkResult.Success
        assertEquals("NO_ELIGIBLE_MARKETS", repoResultBudget.headers["X-Empty-Reason"])
        assertEquals("0", repoResultBudget.headers["X-Eligible-Market-Count"])

        val vmWithRealRepo = ExchangeViewModel(
            appContext = FakeContextMinimal(),
            exchangeRepository = exchangeRepository,
            marketRepository = realMarketRepository,
            technicalAnalysisRepository = FakeTechnicalAnalysisRepositoryMinimal(),
            botRepository = FakeBotRepositoryMinimal(),
            fcmRepository = FakeFcmRepositoryMinimal(),
            tokenManager = FakeTokenManagerMinimal(),
            exchangeConnectionManager = FakeExchangeConnectionManagerMinimal(),
            sessionRepository = FakeTradeSessionRepositoryMinimal(),
            tradeAlertManager = FakeTradeAlertManagerMinimal()
        )

        vmWithRealRepo.fetchMarketCandidates(4.0)
        val uiBudgetEmpty = vmWithRealRepo.marketDataState.value as MarketDataUiState.Empty
        assertEquals("NO_ELIGIBLE_MARKETS", uiBudgetEmpty.emptyReason)
        assertTrue(uiBudgetEmpty.message.contains("Please increase your budget"))

        // 2. Verify safeApiCall + MarketRepositoryImpl extract and preserve headers for NO_TECHNICAL_OPPORTUNITIES
        simulatedHeaders = Headers.headersOf(
            "X-Empty-Reason", "NO_TECHNICAL_OPPORTUNITIES",
            "X-Eligible-Market-Count", "12"
        )
        val repoResultTech = realMarketRepository.getCandidates(25.0) as NetworkResult.Success
        assertEquals("NO_TECHNICAL_OPPORTUNITIES", repoResultTech.headers["X-Empty-Reason"])
        assertEquals("12", repoResultTech.headers["X-Eligible-Market-Count"])

        vmWithRealRepo.fetchMarketCandidates(25.0)
        val uiTechEmpty = vmWithRealRepo.marketDataState.value as MarketDataUiState.Empty
        assertEquals("NO_TECHNICAL_OPPORTUNITIES", uiTechEmpty.emptyReason)
        assertTrue(uiTechEmpty.message.contains("strategy criteria"))
        assertFalse(uiTechEmpty.message.contains("Please increase your budget"))
    }
}

// ── Minimal Fakes ────────────────────────────────────────────────────────────

class FakeContextMinimal : android.content.ContextWrapper(null) {
    override fun getApplicationContext(): android.content.Context = this
}

class FakeExchangeRepository : ExchangeRepository {
    var balancesResult: NetworkResult<List<BalanceItem>> = NetworkResult.Success(emptyList())
    var fetchBalancesCallCount = 0
    override suspend fun validateKeys(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun connectExchange(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun getConnectionStatus(): NetworkResult<ExchangeStatus> = NetworkResult.Success(ExchangeStatus(true, "bybit", "demo", null))
    override suspend fun getBalances(): NetworkResult<List<BalanceItem>> {
        fetchBalancesCallCount++
        return balancesResult
    }
}

class FakeMarketRepositoryMinimal : com.cryptopulse.app.domain.repository.MarketRepository {
    var candidatesResult: NetworkResult<List<com.cryptopulse.app.domain.models.MarketCandidate>> = NetworkResult.Success(emptyList())
    override suspend fun getCandidates(budget: Double): NetworkResult<List<com.cryptopulse.app.domain.models.MarketCandidate>> = candidatesResult
    override suspend fun getCandidates(): NetworkResult<List<com.cryptopulse.app.domain.models.MarketCandidate>> = candidatesResult
    override suspend fun getTicker(symbol: String): NetworkResult<com.cryptopulse.app.domain.models.Ticker> = NetworkResult.Error(NetworkError.Unknown(Exception()))
    override suspend fun getKlines(symbol: String, interval: String, limit: Int): NetworkResult<List<com.cryptopulse.app.domain.models.Kline>> = NetworkResult.Success(emptyList())
}

class FakeTechnicalAnalysisRepositoryMinimal : com.cryptopulse.app.domain.repository.TechnicalAnalysisRepository {
    override suspend fun getAnalysis(symbol: String, strategy: String, config: com.cryptopulse.app.domain.models.TradeSetupConfig?): NetworkResult<com.cryptopulse.app.domain.models.TechnicalAnalysisResult> = NetworkResult.Error(NetworkError.Unknown(Exception()))
    override suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: com.cryptopulse.app.domain.models.TradeSetupConfig?): NetworkResult<com.cryptopulse.app.domain.models.AnalysisSnapshot> = NetworkResult.Error(NetworkError.Unknown(Exception()))
}

class FakeBotRepositoryMinimal : com.cryptopulse.app.domain.repository.BotRepository {
    override val isConnected: kotlinx.coroutines.flow.StateFlow<Boolean> = MutableStateFlow(false)
    override val analysisState: kotlinx.coroutines.flow.StateFlow<com.cryptopulse.app.domain.models.AnalysisSnapshot?> = MutableStateFlow(null)
    override val activeBotAnalysisState: kotlinx.coroutines.flow.StateFlow<com.cryptopulse.app.domain.models.AnalysisSnapshot?> = MutableStateFlow(null)
    override val committedStrategyId: kotlinx.coroutines.flow.StateFlow<String?> = MutableStateFlow(null)
    override val isBotActive: kotlinx.coroutines.flow.StateFlow<Boolean> = MutableStateFlow(false)
    override fun startObserving() {}
    override fun stopObserving() {}
    override fun updateAnalysisState(snapshot: com.cryptopulse.app.domain.models.AnalysisSnapshot?) {}
    override fun updateConnectionState(connected: Boolean) {}
    override suspend fun activateBot(symbols: List<String>, strategy: String, config: com.cryptopulse.app.domain.models.TradeSetupConfig?): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun deactivateBot(): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun stopTrade(): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun getStatus(): NetworkResult<com.cryptopulse.app.domain.models.BotStatus> = NetworkResult.Success(com.cryptopulse.app.domain.models.BotStatus(state = com.cryptopulse.app.domain.models.BotState.NOT_STARTED, isActive = false))
    override suspend fun executeTrade(alertId: String): NetworkResult<com.cryptopulse.app.domain.models.TradeExecutionResult> = NetworkResult.Success(createDummyExecutionResult(alertId))
    override suspend fun executeMockTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto): NetworkResult<com.cryptopulse.app.domain.models.TradeExecutionResult> = NetworkResult.Success(createDummyExecutionResult("mock"))
    override suspend fun getExecutionStatus(positionId: String): NetworkResult<com.cryptopulse.app.domain.models.TradeExecutionResult> = NetworkResult.Success(createDummyExecutionResult(positionId))
    override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<com.cryptopulse.app.domain.models.TradeExecutionResult> = kotlinx.coroutines.flow.flowOf(createDummyExecutionResult(positionId))
    override suspend fun getAlerts(): NetworkResult<List<com.cryptopulse.app.domain.models.BotAlert>> = NetworkResult.Success(emptyList())
    override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun triggerAlert(symbol: String, strategy: String, config: com.cryptopulse.app.domain.models.TradeSetupConfig?): NetworkResult<com.cryptopulse.app.domain.models.BotAlert> = NetworkResult.Success(com.cryptopulse.app.domain.models.BotAlert("a1", symbol, 50000.0, 49000.0, 52000.0, 200.0, strategy, "BUY", "2026-08-24T00:00:00Z"))
}

private fun createDummyExecutionResult(id: String) = com.cryptopulse.app.domain.models.TradeExecutionResult(
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

class FakeFcmRepositoryMinimal : com.cryptopulse.app.domain.repository.FcmRepository {
    override suspend fun registerToken(token: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
}

class FakeTokenManagerMinimal : com.cryptopulse.app.data.local.TokenManager(FakeContextMinimal()) {
    override val tokenFlow: kotlinx.coroutines.flow.StateFlow<com.cryptopulse.app.data.local.TokenState> = MutableStateFlow(com.cryptopulse.app.data.local.TokenState.Uninitialized)
    override suspend fun saveTokens(accessToken: String, refreshToken: String) {}
    override suspend fun getToken(): String? = "fake_token"
    override suspend fun getRefreshToken(): String? = null
    override suspend fun clearTokens() {}
    override fun isTokenExpired(token: String?): Boolean = false
}

class FakeExchangeConnectionManagerMinimal : com.cryptopulse.app.data.local.ExchangeConnectionManager(FakeContextMinimal()) {
    override suspend fun saveConnection(exchangeName: String, environment: String) {}
    override suspend fun getConnectionInfo(): Triple<Boolean, String?, String?> = Triple(true, "bybit", "demo")
    override suspend fun clearConnection() {}
}

class FakeTradeSessionRepositoryMinimal : com.cryptopulse.app.domain.repository.TradeSessionRepository {
    override val selectedStrategyId: kotlinx.coroutines.flow.StateFlow<String?> = MutableStateFlow(null)
    override val tradeSetupConfig: kotlinx.coroutines.flow.StateFlow<com.cryptopulse.app.domain.models.TradeSetupConfig?> = MutableStateFlow(null)
    override fun setStrategyId(id: String) {}
    override fun setTradeSetupConfig(config: com.cryptopulse.app.domain.models.TradeSetupConfig) {}
    override fun clearSession() {}
}

class FakeTradeAlertManagerMinimal : com.cryptopulse.app.service.TradeAlertManager() {
    override fun onNewAlertReceived(alert: Map<String, Any>) {}
    override fun dismissOrExecuteAlert() {}
}
