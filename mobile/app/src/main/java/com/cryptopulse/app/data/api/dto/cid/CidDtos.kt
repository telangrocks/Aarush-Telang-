package com.cryptopulse.app.data.api.dto.cid

import com.cryptopulse.app.forensics.CidEventDto
import com.google.gson.annotations.SerializedName

data class CidStartSessionRequestDto(
    @SerializedName("appVersion") val appVersion: String? = null,
    @SerializedName("deviceModel") val deviceModel: String? = null,
    @SerializedName("environment") val environment: String? = null
)

data class CidStartSessionResponseDto(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("sessionId") val sessionId: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("createdAt") val createdAt: Long? = null,
    @SerializedName("expiresAt") val expiresAt: Long? = null,
    @SerializedName("error") val error: String? = null
)

data class CidPostEventsRequestDto(
    @SerializedName("sessionId") val sessionId: String,
    @SerializedName("events") val events: List<CidEventDto>
)

data class CidPostEventsResponseDto(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("insertedCount") val insertedCount: Int? = null,
    @SerializedName("sessionId") val sessionId: String? = null,
    @SerializedName("error") val error: String? = null
)
