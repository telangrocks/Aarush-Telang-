package com.cryptopulse.app.data.api.dto.market.response

data class KlineDto(
    val openTime: Long,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
    val volume: Double,
    val closeTime: Long,
)
