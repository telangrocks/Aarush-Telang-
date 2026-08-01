package com.cryptopulse.app.data.api.dto.market.response

import com.google.gson.annotations.SerializedName

data class MarketCandidateDto(
    val rank: Int,
    val symbol: String,
    @SerializedName("price") val currentMarketPrice: Double,
    val volume24h: Double,
    val quoteVolume24h: Double,
    val priceChange24h: Double,
    val priceChangePercent24h: Double,
    val score: Double,
    val minNotional: Double,
    val recommendedTimeframe: String,
    val tradeSide: String,
)
