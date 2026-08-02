package com.cryptopulse.app.data.api.dto.exchange.response

data class BalanceItemDataDto(
    val asset: String? = null,
    val currency: String? = null,
    val free: Double? = null,
    val locked: Double? = null,
    val used: Double? = null,
    val total: Double? = null
)

data class ExchangeBalanceResponseDto(
    val success: Boolean = false,
    val exchange: String? = null,
    val environment: String? = null,
    val primaryAsset: String? = "USDT",
    val balances: List<BalanceItemDataDto>? = null,
    val code: String? = null,
    val message: String? = null,
    val hint: String? = null
)
