package com.cryptopulse.app.data.api.dto.exchange.response

data class ExchangeStatusResponseDto(
    val isConnected: Boolean,
    val exchangeName: String?,
    val environment: String?,
    val region: String? = null,
)
