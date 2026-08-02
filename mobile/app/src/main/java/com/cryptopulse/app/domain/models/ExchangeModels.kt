package com.cryptopulse.app.domain.models

import androidx.compose.runtime.Immutable

@Immutable
data class ExchangeStatus(
    val isConnected: Boolean,
    val exchangeName: String?,
    val environment: String?,
    val region: String?
)

@Immutable
data class BalanceItem(
    val asset: String,
    val free: Double,
    val locked: Double,
    val used: Double = 0.0,
    val total: Double
)

@Immutable
data class ExchangeBalance(
    val exchange: String?,
    val environment: String?,
    val primaryAsset: String?,
    val balances: List<BalanceItem>
)
