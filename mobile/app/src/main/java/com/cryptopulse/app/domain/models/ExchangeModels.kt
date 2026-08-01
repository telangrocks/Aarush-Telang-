package com.cryptopulse.app.domain.models

data class ExchangeStatus(
    val isConnected: Boolean,
    val exchangeName: String?,
    val environment: String?,
    val region: String?
)

data class BalanceItem(
    val asset: String,
    val free: Double,
    val locked: Double,
    val total: Double
)

data class ExchangeBalance(
    val exchange: String?,
    val environment: String?,
    val primaryAsset: String?,
    val balances: List<BalanceItem>
)
