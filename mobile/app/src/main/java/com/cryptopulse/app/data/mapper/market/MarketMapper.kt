package com.cryptopulse.app.data.mapper.market

import com.cryptopulse.app.data.api.dto.market.response.*
import com.cryptopulse.app.domain.models.MarketCandidate
import com.cryptopulse.app.domain.models.Kline
import com.cryptopulse.app.domain.models.Ticker

fun MarketCandidateDto.toDomain(): MarketCandidate = MarketCandidate(
    rank = rank,
    symbol = symbol,
    currentMarketPrice = currentMarketPrice,
    volume24h = volume24h,
    quoteVolume24h = quoteVolume24h,
    priceChange24h = priceChange24h,
    priceChangePercent24h = priceChangePercent24h,
    score = score,
    minNotional = minNotional,
    recommendedTimeframe = recommendedTimeframe,
    tradeSide = tradeSide
)

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
