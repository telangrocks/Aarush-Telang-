package com.cryptopulse.app.data.api

import retrofit2.http.GET

data class StrategyParameterSchemaDto(
    val key: String,
    val displayName: String,
    val type: String,
    val defaultValue: String,
    val isRequired: Boolean,
    val minValue: Double?,
    val maxValue: Double?,
    val options: List<String>?
)

data class StrategyManifestDto(
    val id: String,
    val displayName: String,
    val description: String,
    val version: String,
    val category: String,
    val riskProfile: String,
    val parameters: List<StrategyParameterSchemaDto>?
)

data class StrategyDiscoveryResponseDto(
    val version: String,
    val count: Int,
    val strategies: List<StrategyManifestDto>
)

interface StrategyApi {
    @GET("api/strategies")
    suspend fun getStrategies(): StrategyDiscoveryResponseDto
}
