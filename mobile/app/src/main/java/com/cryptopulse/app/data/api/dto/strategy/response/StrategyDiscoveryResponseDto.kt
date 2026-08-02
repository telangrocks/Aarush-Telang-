package com.cryptopulse.app.data.api.dto.strategy.response

import com.google.gson.annotations.SerializedName

data class StrategyParameterSchemaDto(
    @SerializedName("key") val key: String? = null,
    @SerializedName("displayName") val displayName: String? = null,
    @SerializedName("type") val type: String? = null,
    @SerializedName("defaultValue") val defaultValue: String? = null,
    @SerializedName("isRequired") val isRequired: Boolean? = null,
    @SerializedName("minValue") val minValue: Double? = null,
    @SerializedName("maxValue") val maxValue: Double? = null,
    @SerializedName("options") val options: List<String>? = null
)

data class StrategyManifestDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("displayName") val displayName: String? = null,
    @SerializedName("description") val description: String? = null,
    @SerializedName("version") val version: String? = null,
    @SerializedName("category") val category: String? = null,
    @SerializedName("riskProfile") val riskProfile: String? = null,
    @SerializedName("supportedMarkets") val supportedMarkets: List<String>? = null,
    @SerializedName("supportedTimeframes") val supportedTimeframes: List<String>? = null,
    @SerializedName("minimumCandles") val minimumCandles: Int? = null,
    @SerializedName("supportsLong") val supportsLong: Boolean? = null,
    @SerializedName("supportsShort") val supportsShort: Boolean? = null,
    @SerializedName("supportsPaperTrading") val supportsPaperTrading: Boolean? = null,
    @SerializedName("supportsLiveTrading") val supportsLiveTrading: Boolean? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("author") val author: String? = null,
    @SerializedName("parameters") val parameters: List<StrategyParameterSchemaDto>? = null
)

data class StrategyDiscoveryResponseDto(
    @SerializedName("version") val version: String? = null,
    @SerializedName("count") val count: Int? = null,
    @SerializedName("strategies") val strategies: List<StrategyManifestDto>? = null
)
