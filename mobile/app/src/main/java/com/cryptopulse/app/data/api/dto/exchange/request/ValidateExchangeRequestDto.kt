package com.cryptopulse.app.data.api.dto.exchange.request

data class ValidateExchangeRequestDto(
    val exchangeName: String,
    val apiKey: String,
    val apiSecret: String,
    val apiPassphrase: String? = null,
    val environment: String = "mainnet",
)
