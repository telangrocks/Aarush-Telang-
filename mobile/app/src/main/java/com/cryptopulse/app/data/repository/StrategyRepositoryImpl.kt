package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.datasource.remote.strategy.StrategyRemoteDataSource
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.StrategyRepository
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class StrategyRepositoryImpl @Inject constructor(
    private val strategyRemoteDataSource: StrategyRemoteDataSource,
    private val dispatcherProvider: DispatcherProvider
) : StrategyRepository {
    
    private var cachedStrategies: List<Strategy>? = null
    private var lastFetchTime = 0L
    private val CACHE_TTL_MS = 60 * 1000L // 1 minute

    override suspend fun getStrategies(): NetworkResult<List<Strategy>> = withContext(dispatcherProvider.io) {
        val now = System.currentTimeMillis()
        if (cachedStrategies != null && (now - lastFetchTime) < CACHE_TTL_MS) {
            return@withContext NetworkResult.Success(cachedStrategies!!)
        }

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
                        } ?: emptyList()
                    )
                }
                cachedStrategies = strategies
                lastFetchTime = now
                NetworkResult.Success(strategies)
            }
            is NetworkResult.Error -> {
                if (cachedStrategies != null) {
                    NetworkResult.Success(cachedStrategies!!)
                } else {
                    result
                }
            }
        }
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

    private fun parseCategory(cat: String): StrategyCategory {
        return try { StrategyCategory.valueOf(cat.uppercase()) } catch (e: Exception) { StrategyCategory.CUSTOM }
    }

    private fun parseRisk(risk: String): RiskLevel {
        return try { RiskLevel.valueOf(risk.uppercase()) } catch (e: Exception) { RiskLevel.MEDIUM }
    }

    private fun parseParameterType(typeStr: String?): ParameterType {
        if (typeStr.isNullOrBlank()) return ParameterType.DOUBLE
        return try { ParameterType.valueOf(typeStr.uppercase()) } catch (e: Exception) { ParameterType.DOUBLE }
    }
}
