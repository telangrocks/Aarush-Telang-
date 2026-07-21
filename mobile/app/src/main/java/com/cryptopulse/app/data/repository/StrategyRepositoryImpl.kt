package com.cryptopulse.app.data.repository

import com.cryptopulse.app.data.api.StrategyApi
import com.cryptopulse.app.domain.models.*
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.delay

@Singleton
class StrategyRepositoryImpl @Inject constructor(
    private val api: StrategyApi
) : StrategyRepository {
    
    private var cachedStrategies: List<Strategy>? = null
    private var lastFetchTime = 0L
    private val CACHE_TTL_MS = 60 * 1000L // 1 minute

    override suspend fun getStrategies(): Result<List<Strategy>> {
        val now = System.currentTimeMillis()
        if (cachedStrategies != null && (now - lastFetchTime) < CACHE_TTL_MS) {
            return Result.success(cachedStrategies!!)
        }

        return try {
            val response = api.getStrategies()
            val strategies = response.strategies.map { dto ->
                Strategy(
                    id = dto.id,
                    name = dto.displayName,
                    description = dto.description,
                    category = parseCategory(dto.category),
                    riskLevel = parseRisk(dto.riskProfile),
                    schemaVersion = 1,
                    requiredParameters = dto.parameters?.map { p ->
                        StrategyParameterSchema(
                            key = p.key,
                            displayName = p.displayName,
                            type = ParameterType.valueOf(p.type),
                            defaultValue = p.defaultValue,
                            isRequired = p.isRequired,
                            minValue = p.minValue,
                            maxValue = p.maxValue,
                            options = p.options
                        )
                    } ?: emptyList()
                )
            }
            cachedStrategies = strategies
            lastFetchTime = now
            Result.success(strategies)
        } catch (e: Exception) {
            e.printStackTrace()
            // Fallback to cache if available, else error
            if (cachedStrategies != null) {
                Result.success(cachedStrategies!!)
            } else {
                Result.failure(e)
            }
        }
    }

    override suspend fun getStrategyById(id: String): Result<Strategy?> {
        if (cachedStrategies == null) {
            val result = getStrategies()
            if (result.isFailure) {
                return Result.failure(result.exceptionOrNull() ?: Exception("Failed to fetch strategies"))
            }
        }
        val strategy = cachedStrategies?.find { it.id == id }
        return Result.success(strategy)
    }

    private fun parseCategory(cat: String): StrategyCategory {
        return try { StrategyCategory.valueOf(cat.uppercase()) } catch (e: Exception) { StrategyCategory.CUSTOM }
    }

    private fun parseRisk(risk: String): RiskLevel {
        return try { RiskLevel.valueOf(risk.uppercase()) } catch (e: Exception) { RiskLevel.MEDIUM }
    }
}
