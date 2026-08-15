package com.cryptopulse.app.data.mapper.market

import com.cryptopulse.app.data.api.dto.market.response.*
import com.cryptopulse.app.domain.models.MarketCandidate
import com.cryptopulse.app.domain.models.Kline
import com.cryptopulse.app.domain.models.Ticker

fun MarketCandidateDto.toDomain(): MarketCandidate {
    val sym = symbol?.takeIf { it.isNotBlank() } ?: "UNKNOWN"
    val pair = pairName?.takeIf { it.isNotBlank() } ?: "$sym/USDT"
    return MarketCandidate(
        rank = rank ?: 0,
        symbol = sym,
        pairName = pair,
        currentMarketPrice = currentMarketPrice?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0,
        volume24h = volume24h?.takeIf { !it.isNaN() && !it.isInfinite() }?.coerceAtLeast(0.0) ?: 0.0,
        quoteVolume24h = quoteVolume24h?.takeIf { !it.isNaN() && !it.isInfinite() }?.coerceAtLeast(0.0) ?: 0.0,
        priceChange24h = priceChange24h?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0,
        priceChangePercent24h = priceChangePercent24h?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0,
        highPrice24h = highPrice24h?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0,
        lowPrice24h = lowPrice24h?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0,
        score = score?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0,
        minNotional = minNotional?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0,
        minOrderQty = minOrderQty?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0,
        qtyStep = qtyStep?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0,
        tickSize = tickSize?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0,
        tradeSide = tradeSide ?: "NEUTRAL"
    )
}

fun KlineDto.toDomain(): Kline = Kline(
    openTime = openTime,
    open = open,
    high = high,
    low = low,
    close = close,
    volume = volume,
    closeTime = closeTime
)

fun TickerResponseDto.toDomain(): Ticker = Ticker(
    symbol = symbol,
    price = price,
    volume24h = volume24h,
    quoteVolume24h = quoteVolume24h,
    priceChange24h = priceChange24h,
    priceChangePercent24h = priceChangePercent24h,
    highPrice24h = highPrice24h,
    lowPrice24h = lowPrice24h,
    minNotional = minNotional,
    minOrderQty = minOrderQty,
    maxOrderQty = maxOrderQty,
    tickSize = tickSize,
    lotSize = lotSize,
    timestamp = timestamp
)
