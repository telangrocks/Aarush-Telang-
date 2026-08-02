package com.cryptopulse.app.domain.models

data class MarketCandidate(
    val rank: Int,
    val symbol: String,
    val pairName: String,
    val currentMarketPrice: Double,
    val volume24h: Double,
    val quoteVolume24h: Double,
    val priceChange24h: Double,
    val priceChangePercent24h: Double,
    val highPrice24h: Double,
    val lowPrice24h: Double,
    val score: Double,
    val minNotional: Double,
    val recommendedTimeframe: String,
    val tradeSide: String
)

data class Ticker(
    val symbol: String,
    val price: Double,
    val volume24h: Double,
    val quoteVolume24h: Double,
    val priceChange24h: Double,
    val priceChangePercent24h: Double,
    val highPrice24h: Double,
    val lowPrice24h: Double,
    val minNotional: Double,
    val minOrderQty: Double,
    val maxOrderQty: Double,
    val tickSize: Double,
    val lotSize: Double,
    val timestamp: String
)

data class Kline(
    val openTime: Long,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
    val volume: Double,
    val closeTime: Long
)
