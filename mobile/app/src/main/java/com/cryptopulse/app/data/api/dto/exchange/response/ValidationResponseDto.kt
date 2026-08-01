package com.cryptopulse.app.data.api.dto.exchange.response

data class ValidationResponseDto(
    val success: Boolean,
    val message: String,
    val code: String? = null,
    val hint: String? = null,
)
