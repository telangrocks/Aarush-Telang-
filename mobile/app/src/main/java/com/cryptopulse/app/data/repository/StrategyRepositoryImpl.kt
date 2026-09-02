package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.datasource.remote.strategy.StrategyRemoteDataSource
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.StrategyRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class StrategyRepositoryImpl @Inject constructor(
    private val strategyRemoteDataSource: StrategyRemoteDataSource,
    private val dispatcherProvider: DispatcherProvider
) : StrategyRepository {
    
    private var scope: CoroutineScope = CoroutineScope(SupervisorJob() + dispatcherProvider.io)

    constructor(
        strategyRemoteDataSource: StrategyRemoteDataSource,
        dispatcherProvider: DispatcherProvider,
        externalScope: CoroutineScope?
    ) : this(strategyRemoteDataSource, dispatcherProvider) {
        if (externalScope != null) {
            this.scope = externalScope
        }
    }

    private var cachedStrategies: List<Strategy>? = null
    private var lastFetchTime = 0L
    private val CACHE_TTL_MS = 60 * 1000L // 1 minute

    private val stateMutex = Mutex()
    private var inFlightDeferred: Deferred<NetworkResult<List<Strategy>>>? = null

    override suspend fun getStrategies(): NetworkResult<List<Strategy>> = withContext(dispatcherProvider.io) {
        val now = System.currentTimeMillis()
        if (cachedStrategies != null && (now - lastFetchTime) < CACHE_TTL_MS) {
            return@withContext NetworkResult.Success(cachedStrategies!!)
        }

        val deferredToAwait: Deferred<NetworkResult<List<Strategy>>> = stateMutex.withLock {
            val lockNow = System.currentTimeMillis()
            if (cachedStrategies != null && (lockNow - lastFetchTime) < CACHE_TTL_MS) {
                return@withContext NetworkResult.Success(cachedStrategies!!)
            }

            inFlightDeferred ?: scope.async {
                try {
                    when (val result = strategyRemoteDataSource.getAvailableStrategies()) {
                        is NetworkResult.Success -> {
                            val strategies = (result.data.strategies ?: emptyList()).map { dto ->
                                Strategy(
                                    id = dto.id ?: "unknown",
                                    name = dto.displayName ?: "Unnamed Strategy",
                                    description = dto.description ?: "",
                                    category = parseCategory(dto.category ?: "CUSTOM"),
                                    riskLevel = parseRisk(dto.riskProfile ?: "MEDIUM"),
                                    schemaVersion = 1,
                                    version = dto.version ?: "1.0",
                                    supportedMarkets = dto.supportedMarkets ?: emptyList(),
                                    supportedTimeframes = dto.supportedTimeframes ?: emptyList(),
                                    minimumCandles = dto.minimumCandles ?: 0,
                                    supportsLong = dto.supportsLong ?: true,
                                    supportsShort = dto.supportsShort ?: true,
                                    supportsPaperTrading = dto.supportsPaperTrading ?: true,
                                    supportsLiveTrading = dto.supportsLiveTrading ?: true,
                                    status = dto.status ?: "ACTIVE",
                                    author = dto.author ?: "CryptoPulse Core",
                                    requiredParameters = dto.parameters?.map { p ->
                                        StrategyParameterSchema(
                                            key = p.key ?: "",
                                            displayName = p.displayName ?: "",
                                            type = parseParameterType(p.type),
                                            defaultValue = p.defaultValue ?: "",
                                            isRequired = p.isRequired ?: false,
                                            minValue = p.minValue,
                                            maxValue = p.maxValue,
                                            options = p.options
                                         )
                                    } ?: emptyList(),
                                    defaultRiskParameters = dto.defaultConfiguration?.riskParameters ?: emptyMap()
                                )
                            }
                            stateMutex.withLock {
                                cachedStrategies = strategies
                                lastFetchTime = System.currentTimeMillis()
                            }
                            NetworkResult.Success(strategies)
                        }
                        is NetworkResult.Error -> {
                            stateMutex.withLock {
                                if (cachedStrategies != null) {
                                    NetworkResult.Success(cachedStrategies!!)
                                } else {
                                    result
                                }
                            }
                        }
                    }
                } finally {
                    stateMutex.withLock {
                        inFlightDeferred = null
                    }
                }
            }.also { inFlightDeferred = it }
        }

        deferredToAwait.await()
    }

    override suspend fun getStrategyById(id: String): NetworkResult<Strategy?> = withContext(dispatcherProvider.io) {
        if (cachedStrategies == null) {
            val result = getStrategies()
            if (result is NetworkResult.Error) {
                return@withContext result
            }
        }
        val strategy = cachedStrategies?.find { it.id == id }
        NetworkResult.Success(strategy)
    }

    override fun clearCache() {
        cachedStrategies = null
        lastFetchTime = 0L
    }

    private fun parseCategory(cat: String): StrategyCategory {
        val sanitized = cat.trim().uppercase().replace(" ", "_").replace("-", "_")
        return try { StrategyCategory.valueOf(sanitized) } catch (e: Exception) { StrategyCategory.CUSTOM }
    }

    private fun parseRisk(risk: String): RiskLevel {
        val sanitized = risk.trim().uppercase().replace(" ", "_").replace("-", "_")
        return when (sanitized) {
            "LOW" -> RiskLevel.LOW
            "MEDIUM" -> RiskLevel.MEDIUM
            "HIGH", "MEDIUM_HIGH" -> RiskLevel.HIGH
            else -> RiskLevel.MEDIUM
        }
    }

    private fun parseParameterType(typeStr: String?): ParameterType {
        if (typeStr.isNullOrBlank()) return ParameterType.DOUBLE
        return try { ParameterType.valueOf(typeStr.uppercase()) } catch (e: Exception) { ParameterType.DOUBLE }
    }
}
