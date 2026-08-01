package com.cryptopulse.app.data.api.dto.shared.response

import com.google.gson.annotations.SerializedName

data class ActionResponseDto(
    @SerializedName("success") val success: Boolean,
    @SerializedName("message") val message: String,
    @SerializedName("code") val code: String? = null,
    @SerializedName("hint") val hint: String? = null
)

data class ApiErrorDto(
    @SerializedName("message") val message: String?,
    @SerializedName("hint") val hint: String?,
    @SerializedName("details") val details: String?,
    @SerializedName("code") val code: String?,
    @SerializedName("exchangeCode") val exchangeCode: Int?
)
