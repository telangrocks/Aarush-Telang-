package com.cryptopulse.app.data.api.dto.market.response

data class TickerResponseDto(
    val symbol: String,
    val price: Double,
    val volume24h: Double,
    val quoteVolume24h: Double,
    val priceChange24h: Double,
    val priceChangePercent24h: Double,
    val highPrice24h: Double,
    val lowPrice24h: Double,
    val minNotional: Double?,
    val minOrderQty: Double?,
    val maxOrderQty: Double?,
    val tickSize: Double?,
    val lotSize: Double?,
    val timestamp: String,
)
