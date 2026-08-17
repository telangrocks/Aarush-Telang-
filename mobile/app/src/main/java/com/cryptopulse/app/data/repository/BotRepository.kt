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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class BotRepositoryImpl @Inject constructor(
    private val botRemoteDataSource: BotRemoteDataSource,
    private val dispatcherProvider: DispatcherProvider
) : BotRepository {

    private val scope = CoroutineScope(dispatcherProvider.io + Job())
    private var pollingJob: Job? = null

    private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
    override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()

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
                if (result.data.success) NetworkResult.Success(Unit)
                else NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Unknown(Exception(result.data.message)))
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun deactivateBot(): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.deactivate()) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> result
        }
    }

    override suspend fun getStatus(): NetworkResult<BotState> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.getStatus()) {
            is NetworkResult.Success -> {
                val state = if (result.data.isActive) BotState.ANALYSING else BotState.STOPPED
                NetworkResult.Success(state)
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun executeTrade(): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        when (val result = botRemoteDataSource.executeTrade()) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> result
        }
    }

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
        if (pollingJob?.isActive == true) return
        pollingJob = scope.launch {
            _isConnected.value = true
            while (pollingJob?.isActive == true) {
                when (val result = botRemoteDataSource.getAnalysisStatus()) {
                    is NetworkResult.Success -> {
                        _analysisState.value = result.data.toDomain()
                    }
                    is NetworkResult.Error -> {
                        _isConnected.value = false
                    }
                }
                delay(3000L)
            }
        }
    }

    override fun stopObserving() {
        pollingJob?.cancel()
        pollingJob = null
        _isConnected.value = false
    }
}
