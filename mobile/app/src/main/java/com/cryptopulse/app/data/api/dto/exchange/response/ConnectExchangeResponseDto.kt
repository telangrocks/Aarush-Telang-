package com.cryptopulse.app.data.api.dto.exchange.response

data class ConnectExchangeResponseDto(
    val success: Boolean,
    val message: String,
    val exchangeName: String?,
    val environment: String? = null,
    val code: String? = null,
    val hint: String? = null,
)
