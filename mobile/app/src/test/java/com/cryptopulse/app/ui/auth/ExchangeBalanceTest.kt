package com.cryptopulse.app.ui.auth

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.BalanceItem
import com.cryptopulse.app.domain.models.ExchangeStatus
import com.cryptopulse.app.domain.repository.ExchangeRepository
import com.cryptopulse.app.core.error.NetworkError
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ExchangeBalanceTest {

    private lateinit var viewModel: ExchangeViewModel
    private lateinit var exchangeRepository: FakeExchangeRepository
    private val testDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        exchangeRepository = FakeExchangeRepository()
        
        // Use a minimal approach - we only care about fetchBalances calling exchangeRepository.getBalances()
        // and updating _balances state.
        viewModel = ExchangeViewModel(
            appContext = FakeContextMinimal(),
            exchangeRepository = exchangeRepository,
            marketRepository = FakeMarketRepositoryMinimal(),
            technicalAnalysisRepository = FakeTechnicalAnalysisRepositoryMinimal(),
            botRepository = FakeBotRepositoryMinimal(),
            fcmRepository = FakeFcmRepositoryMinimal(),
            tokenManager = FakeTokenManagerMinimal(),
            exchangeConnectionManager = FakeExchangeConnectionManagerMinimal(),
            sessionRepository = FakeTradeSessionRepositoryMinimal(),
            tradeAlertManager = FakeTradeAlertManagerMinimal()
        )
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
}

// ── Minimal Fakes ────────────────────────────────────────────────────────────

class FakeContextMinimal : android.content.ContextWrapper(null) {
    override fun getApplicationContext(): android.content.Context = this
}

class FakeExchangeRepository : ExchangeRepository {
    var balancesResult: NetworkResult<List<BalanceItem>> = NetworkResult.Success(emptyList())
    override suspend fun validateKeys(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun connectExchange(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun getConnectionStatus(): NetworkResult<ExchangeStatus> = NetworkResult.Success(ExchangeStatus(true, "bybit", "demo", null))
    override suspend fun getBalances(): NetworkResult<List<BalanceItem>> = balancesResult
}

class FakeMarketRepositoryMinimal : com.cryptopulse.app.domain.repository.MarketRepository {
    override suspend fun getCandidates(): NetworkResult<List<com.cryptopulse.app.domain.models.MarketCandidate>> = NetworkResult.Success(emptyList())
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
    override suspend fun activateBot(symbol: String, strategy: String, config: com.cryptopulse.app.domain.models.TradeSetupConfig?): NetworkResult<Unit> = NetworkResult.Success(Unit)
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
