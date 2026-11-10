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
    private val tokenManager: TokenManager? = null
) : BotRepository {

    constructor(
        botRemoteDataSource: BotRemoteDataSource,
        dispatcherProvider: DispatcherProvider
    ) : this(botRemoteDataSource, dispatcherProvider, null)

    private val scope = CoroutineScope(dispatcherProvider.io + Job())
    private var pollingJob: Job? = null
    private val pollingMutex = Mutex()

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

    init {
        tokenManager?.let { tm ->
            scope.launch {
                tm.tokenFlow.collect { state ->
                    if (state is TokenState.Unauthenticated || state is TokenState.Uninitialized) {
                        stopObserving()
                    }
                }
            }
        }
    }

    override suspend fun activateBot(symbols: List<String>, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        if (symbols.isEmpty()) {
            return@withContext NetworkResult.Error(
                com.cryptopulse.app.core.error.NetworkError.HttpError(
                    code = 400,
                    message = "Cannot activate bot: no eligible candidate symbols provided.",
                    detail = "Candidate list is empty"
                )
            )
        }
        val resolvedPositionSize = config?.tradeValueUsdt?.takeIf { it > 0.0 }
        if (resolvedPositionSize == null) {
            return@withContext NetworkResult.Error(
                com.cryptopulse.app.core.error.NetworkError.HttpError(
                    code = 400,
                    message = "Cannot activate bot: valid trade budget is required.",
                    detail = "Invalid or missing position size"
                )
            )
        }

        val primarySymbol = symbols.first()
        val mergedConfig = mutableMapOf<String, Any>()
        config?.parameters?.let { mergedConfig.putAll(it) }
        config?.riskParameters?.let { if (it.isNotEmpty()) mergedConfig["riskParameters"] = it }

        val request = ActivateBotRequestDto(
            symbols = symbols,
            coinId = primarySymbol,
            strategy = strategy,
            targetEntryPrice = config?.entryPrice?.takeIf { it > 0.0 },
            positionSize = resolvedPositionSize,
            config = mergedConfig.takeIf { it.isNotEmpty() },
            approvalGeneration = config?.approvalGeneration
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

    override suspend fun activateBot(symbol: String, strategy: String, config: TradeSetupConfig?): NetworkResult<Unit> =
        if (symbol.isBlank()) {
            NetworkResult.Error(
                com.cryptopulse.app.core.error.NetworkError.HttpError(
                    code = 400,
                    message = "Cannot activate bot: symbol is blank.",
                    detail = "Symbol is blank"
                )
            )
        } else {
            activateBot(listOf(symbol), strategy, config)
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
                _committedStrategyId.value = if (result.data.isActive) result.data.strategy else null
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
            is NetworkResult.Success -> {
                if (!result.data.success) {
                    NetworkResult.Error(
                        com.cryptopulse.app.core.error.NetworkError.HttpError(
                            code = 400,
                            message = result.data.message.ifBlank { "Trade execution rejected by exchange" },
                            detail = result.data.message
                        )
                    )
                } else {
                    NetworkResult.Success(result.data.toDomain(alertId))
                }
            }
            is NetworkResult.Error -> {
                if (result.error is com.cryptopulse.app.core.error.NetworkError.Timeout ||
                    (result.error is com.cryptopulse.app.core.error.NetworkError.HttpError && (result.error.code == 502 || result.error.code == 504)) ||
                    result.error is com.cryptopulse.app.core.error.NetworkError.Unknown
                ) {
                    val fallback = verifyStatusOnTimeout(alertId)
                    if (fallback != null) return@withContext fallback
                }
                result
            }
        }
    }

    override suspend fun executeTrade(request: com.cryptopulse.app.data.api.dto.bot.request.ExecuteTradeRequestDto): NetworkResult<TradeExecutionResult> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.executeTrade(request)) {
            is NetworkResult.Success -> {
                if (!result.data.success) {
                    NetworkResult.Error(
                        com.cryptopulse.app.core.error.NetworkError.HttpError(
                            code = 400,
                            message = result.data.message.ifBlank { "Trade execution rejected by exchange" },
                            detail = result.data.message
                        )
                    )
                } else {
                    NetworkResult.Success(result.data.toDomain(request.alertId))
                }
            }
            is NetworkResult.Error -> {
                if (result.error is com.cryptopulse.app.core.error.NetworkError.Timeout ||
                    (result.error is com.cryptopulse.app.core.error.NetworkError.HttpError && (result.error.code == 502 || result.error.code == 504)) ||
                    result.error is com.cryptopulse.app.core.error.NetworkError.Unknown
                ) {
                    val fallback = verifyStatusOnTimeout(request.alertId)
                    if (fallback != null) return@withContext fallback
                }
                result
            }
        }
    }

    private suspend fun verifyStatusOnTimeout(positionId: String, maxAttempts: Int = 3, delayMs: Long = 1000L): NetworkResult<TradeExecutionResult>? {
        for (attempt in 1..maxAttempts) {
            when (val statusRes = botRemoteDataSource.getExecutionStatus(positionId)) {
                is NetworkResult.Success -> {
                    val dto = statusRes.data
                    val isConfirmedOrActive = dto.success && (
                        dto.isFilled ||
                        dto.entryStatus == "FILLED" ||
                        dto.entryStatus == "OPEN" ||
                        dto.entryStatus == "PENDING_ENTRY" ||
                        !dto.orderId.isNullOrBlank()
                    )
                    val isExplicitFailure = dto.entryStatus == "FAILED" ||
                        dto.entryStatus == "CANCELLED" ||
                        dto.entryStatus == "REJECTED" ||
                        (!dto.success && !dto.orderId.isNullOrBlank())

                    if (isConfirmedOrActive) {
                        return NetworkResult.Success(dto.toDomain())
                    } else if (isExplicitFailure) {
                        return NetworkResult.Error(
                            com.cryptopulse.app.core.error.NetworkError.HttpError(
                                code = 400,
                                message = dto.message ?: "Order execution was rejected or cancelled by exchange.",
                                detail = dto.message
                            )
                        )
                    }
                }
                is NetworkResult.Error -> {
                    // Endpoint might still be completing or unreachable; retry up to maxAttempts
                }
            }
            if (attempt < maxAttempts) {
                delay(delayMs)
            }
        }
        return null
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
                
                val token = tokenManager?.getToken()
                if (tokenManager != null && token.isNullOrEmpty()) {
                    _isConnected.value = false
                    return@withLock
                }

                _isConnected.value = true
                pollingJob = scope.launch {
                    while (isActive) {
                        val result = botRemoteDataSource.getAnalysisStatus()
                        when (result) {
                            is NetworkResult.Success -> {
                                val dto = result.data
                                val domainSnapshot = dto.toDomain()
                                _analysisState.value = domainSnapshot
                                _activeBotAnalysisState.value = domainSnapshot

                                val rawState = dto.engineStatus?.state?.uppercase()
                                val backendCommitted = dto.committedStrategy
                                    ?: dto.engineStatus?.committedStrategy
                                    ?: dto.engineStatus?.activeStrategy

                                val isAuthoritativeInactive = rawState == "STOPPED" || rawState == "INACTIVE" || dto.isActive == false

                                if (isAuthoritativeInactive) {
                                    _isBotActive.value = false
                                    _committedStrategyId.value = null
                                } else if (_isBotActive.value) {
                                    // Rule 1 & Rule 4: Bot is active on client (user-initiated activation).
                                    // An analysis poll result must NEVER overwrite committed strategy
                                    // with an analysis/fallback strategy!
                                    if (!backendCommitted.isNullOrBlank() && (dto.committedStrategy != null || dto.engineStatus?.committedStrategy != null)) {
                                        _committedStrategyId.value = backendCommitted
                                    }
                                } else {
                                    // Bot was not locally active, check if backend is authoritatively active:
                                    val isAuthoritativeActive = (dto.isActive == true || rawState == "WAITING" || rawState == "ANALYSING" || rawState == "RUNNING" || rawState == "ACTIVE") &&
                                        !backendCommitted.isNullOrBlank() && rawState != "PREVIEW"

                                    if (isAuthoritativeActive) {
                                        _isBotActive.value = true
                                        _committedStrategyId.value = backendCommitted
                                    }
                                }
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
