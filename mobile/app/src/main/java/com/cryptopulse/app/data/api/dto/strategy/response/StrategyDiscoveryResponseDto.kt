package com.cryptopulse.app.data.api.dto.strategy.response

import com.google.gson.annotations.SerializedName

data class StrategyParameterSchemaDto(
    @SerializedName("key") val key: String,
    @SerializedName("displayName") val displayName: String,
    @SerializedName("type") val type: String,
    @SerializedName("defaultValue") val defaultValue: String,
    @SerializedName("isRequired") val isRequired: Boolean,
    @SerializedName("minValue") val minValue: Double?,
    @SerializedName("maxValue") val maxValue: Double?,
    @SerializedName("options") val options: List<String>?
)

data class StrategyManifestDto(
    @SerializedName("id") val id: String,
    @SerializedName("displayName") val displayName: String,
    @SerializedName("description") val description: String,
    @SerializedName("version") val version: String,
    @SerializedName("category") val category: String,
    @SerializedName("riskProfile") val riskProfile: String,
    @SerializedName("parameters") val parameters: List<StrategyParameterSchemaDto>?
)

data class StrategyDiscoveryResponseDto(
    @SerializedName("version") val version: String,
    @SerializedName("count") val count: Int,
    @SerializedName("strategies") val strategies: List<StrategyManifestDto>
)
