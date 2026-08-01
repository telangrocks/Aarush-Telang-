package com.cryptopulse.app.data.api.dto.exchange.response

data class BalanceItemDataDto(
    val asset: String,
    val free: Double,
    val locked: Double,
    val total: Double
)

data class ExchangeBalanceResponseDto(
    val success: Boolean,
    val exchange: String? = null,
    val environment: String? = null,
    val primaryAsset: String? = "USDT",
    val balances: List<BalanceItemDataDto>? = null,
    val code: String? = null,
    val message: String? = null,
    val hint: String? = null
)
