package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.bot.request.*
import com.cryptopulse.app.data.datasource.remote.bot.BotRemoteDataSource
import com.cryptopulse.app.data.mapper.bot.toDomain
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.BotRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.TokenState
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.isActive
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class BotRepositoryImpl @Inject constructor(
    private val botRemoteDataSource: BotRemoteDataSource,
    private val dispatcherProvider: DispatcherProvider,
    private val tokenManager: TokenManager
) : BotRepository {

    constructor(
        botRemoteDataSource: BotRemoteDataSource,
        dispatcherProvider: DispatcherProvider
    ) : this(botRemoteDataSource, dispatcherProvider, TokenManager(FakeContextForBot()))

    private val scope = CoroutineScope(dispatcherProvider.io + Job())
    private var pollingJob: Job? = null
    private val pollingMutex = Mutex()

    init {
        scope.launch {
            tokenManager.tokenFlow.collect { state ->
                if (state is TokenState.Unauthenticated || state is TokenState.Uninitialized) {
                    stopObserving()
                }
            }
        }
    }

    private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
    override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()

    private val _activeBotAnalysisState = MutableStateFlow<AnalysisSnapshot?>(null)
    override val activeBotAnalysisState: StateFlow<AnalysisSnapshot?> = _activeBotAnalysisState.asStateFlow()

    private val _committedStrategyId = MutableStateFlow<String?>(null)
    override val committedStrategyId: StateFlow<String?> = _committedStrategyId.asStateFlow()

    private val _isBotActive = MutableStateFlow(false)
    override val isBotActive: StateFlow<Boolean> = _isBotActive.asStateFlow()

    private val _isConnected = MutableStateFlow(false)
    override val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

    override suspend fun activateBot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        val mergedConfig = mutableMapOf<String, Any>()
        config?.parameters?.let { mergedConfig.putAll(it) }
        config?.riskParameters?.let { if (it.isNotEmpty()) mergedConfig["riskParameters"] = it }

        val request = ActivateBotRequestDto(
            coinId = symbol,
            strategy = strategy,
            targetEntryPrice = config?.entryPrice?.takeIf { it > 0.0 },
            positionSize = config?.tradeValueUsdt?.takeIf { it > 0.0 },
            config = mergedConfig.takeIf { it.isNotEmpty() }
        )
        when (val result = botRemoteDataSource.activate(request)) {
            is NetworkResult.Success -> {
                if (result.data.success) {
                    _committedStrategyId.value = strategy
                    _isBotActive.value = true
                    NetworkResult.Success(Unit)
                } else {
                    NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Unknown(Exception(result.data.message)))
                }
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun deactivateBot(): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.deactivate()) {
            is NetworkResult.Success -> {
                _isBotActive.value = false
                _committedStrategyId.value = null
                NetworkResult.Success(Unit)
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun getStatus(): NetworkResult<BotStatus> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.getStatus()) {
            is NetworkResult.Success -> {
                val state = if (result.data.isActive) BotState.ANALYSING else BotState.STOPPED
                _isBotActive.value = result.data.isActive
                _committedStrategyId.value = result.data.strategy
                val botStatus = BotStatus(
                    state = state,
                    isActive = result.data.isActive,
                    coinId = result.data.coinId,
                    strategy = result.data.strategy
                )
                NetworkResult.Success(botStatus)
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun executeTrade(alertId: String): NetworkResult<TradeExecutionResult> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.executeTrade(alertId)) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.toDomain(alertId))
            is NetworkResult.Error -> result
        }
    }

    @Deprecated("Do not use in production. Real trades must use executeTrade(alertId).", level = DeprecationLevel.WARNING)
    override suspend fun executeMockTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto): NetworkResult<TradeExecutionResult> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.executeMockTrade(request)) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.toDomain(request.alertId.ifBlank { "mock_trade" }))
            is NetworkResult.Error -> result
        }
    }

    override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionResult> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.getExecutionStatus(positionId)) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.toDomain())
            is NetworkResult.Error -> result
        }
    }

    override fun pollExecutionStatus(positionId: String, timeoutMs: Long, pollIntervalMs: Long): kotlinx.coroutines.flow.Flow<TradeExecutionResult> = kotlinx.coroutines.flow.flow {
        val startTime = System.currentTimeMillis()
        while (System.currentTimeMillis() - startTime < timeoutMs) {
            when (val result = botRemoteDataSource.getExecutionStatus(positionId)) {
                is NetworkResult.Success -> {
                    val domainModel = result.data.toDomain()
                    emit(domainModel)
                    if (domainModel.isFilled || domainModel.entryStatus == "FAILED" || domainModel.entryStatus == "CANCELLED" || domainModel.entryStatus == "REJECTED") {
                        break
                    }
                }
                is NetworkResult.Error -> {
                    // Continue polling on transient errors during active window
                }
            }
            delay(pollIntervalMs)
        }
    }.flowOn(dispatcherProvider.io)

    override suspend fun stopTrade(): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.stopTrade()) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> result
        }
    }

    override suspend fun getAlerts(): NetworkResult<List<BotAlert>> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.getAlerts()) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.map { it.toDomain() })
            is NetworkResult.Error -> result
        }
    }

    override suspend fun acknowledgeAlert(alertId: String): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.acknowledgeAlert(AcknowledgeAlertRequestDto(alertId))) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> result
        }
    }

    override suspend fun triggerAlert(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<BotAlert> = withContext(dispatcherProvider.io) {
        val request = com.cryptopulse.app.data.api.dto.technicalanalysis.request.TechnicalAnalysisRequestDto(
            symbol = symbol,
            strategy = strategy,
            config = config?.let { com.google.gson.Gson().fromJson(com.google.gson.Gson().toJson(it), Map::class.java) as Map<String, Any> }
        )
        when (val result = botRemoteDataSource.triggerAlert(request)) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.toDomain())
            is NetworkResult.Error -> result
        }
    }

    override fun updateAnalysisState(snapshot: AnalysisSnapshot?) {
        _analysisState.value = snapshot
    }

    override fun updateConnectionState(connected: Boolean) {
        _isConnected.value = connected
    }

    override fun startObserving() {
        scope.launch {
            pollingMutex.withLock {
                if (pollingJob?.isActive == true) return@withLock
                
                val token = tokenManager.getToken()
                if (token.isNullOrEmpty()) {
                    _isConnected.value = false
                    return@withLock
                }

                _isConnected.value = true
                pollingJob = scope.launch {
                    while (isActive) {
                        when (val result = botRemoteDataSource.getAnalysisStatus()) {
                            is NetworkResult.Success -> {
                                val dto = result.data
                                val domainSnapshot = dto.toDomain()
                                _analysisState.value = domainSnapshot
                                _activeBotAnalysisState.value = domainSnapshot
                                _committedStrategyId.value = dto.strategyMetadata?.strategyId ?: dto.engineStatus?.activeStrategy
                                _isBotActive.value = dto.engineStatus?.state != null && dto.engineStatus.state != "STOPPED"
                            }
                            is NetworkResult.Error -> {
                                _isConnected.value = false
                            }
                        }
                        delay(3000L)
                    }
                }
            }
        }
    }

    override fun stopObserving() {
        pollingJob?.cancel()
        pollingJob = null
        _isConnected.value = false
    }
}

private class FakeContextForBot : android.content.ContextWrapper(null) {
    override fun getApplicationContext(): android.content.Context = this
}
