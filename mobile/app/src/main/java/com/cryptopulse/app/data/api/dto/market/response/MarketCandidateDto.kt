package com.cryptopulse.app.data.api.dto.market.response

import com.google.gson.annotations.SerializedName

data class MarketCandidateDto(
    val rank: Int? = null,
    val symbol: String? = null,
    val pairName: String? = null,
    @SerializedName("price") val currentMarketPrice: Double? = null,
    val volume24h: Double? = null,
    val quoteVolume24h: Double? = null,
    val priceChange24h: Double? = null,
    val priceChangePercent24h: Double? = null,
    val highPrice24h: Double? = null,
    val lowPrice24h: Double? = null,
    val score: Double? = null,
    val minNotional: Double? = null,
    val minOrderQty: Double? = null,
    val qtyStep: Double? = null,
    val tickSize: Double? = null,
    val minPrice: Double? = null,
    val maxPrice: Double? = null,
    val maxQty: Double? = null,
    val tradeSide: String? = null,
)
