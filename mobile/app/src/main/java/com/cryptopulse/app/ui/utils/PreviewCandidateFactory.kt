package com.cryptopulse.app.ui.utils

import com.cryptopulse.app.ui.screens.MarketCandidate
import androidx.compose.ui.graphics.Color

object PreviewCandidateFactory {

    fun createSampleCandidate(
        rank: Int = 1,
        symbol: String = "ADA",
        pairName: String = "ADA/USDT",
        price: Double = 0.1863,
        priceChange: Double = 8.377,
        quoteVolume: Double = 4769496.04,
        score: Double = 133.77,
        highPrice: Double = 0.1876,
        lowPrice: Double = 0.1697,
        minNotional: Double = 5.0,
        timeframe: String = "1h",
        side: String = "BUY"
    ): MarketCandidate {
        return MarketCandidate(
            rank = rank,
            symbol = symbol,
            pairName = pairName,
            coinName = symbol,
            currentMarketPrice = price,
            volume24h = quoteVolume * 5.0,
            quoteVolume24h = quoteVolume,
            priceChangePercent24h = priceChange,
            score = score,
            highPrice24h = highPrice,
            lowPrice24h = lowPrice,
            minNotional = minNotional,
            tradeSide = side,
            formattedPrice = "",
            coinColor = Color(0xFF00B4FF)
        )
    }

    fun createSampleCandidateList(): List<MarketCandidate> {
        return listOf(
            createSampleCandidate(rank = 2, symbol = "ETH", pairName = "ETH/USDT", price = 3450.25, priceChange = 3.12, score = 112.50, side = "BUY", timeframe = "1h"),
            createSampleCandidate(rank = 3, symbol = "SOL", pairName = "SOL/USDT", price = 145.80, priceChange = -1.85, score = 98.40, side = "SELL", timeframe = "15m"),
            createSampleCandidate(rank = 4, symbol = "BTC", pairName = "BTC/USDT", price = 67800.00, priceChange = 1.45, score = 95.10, side = "BUY", timeframe = "4h")
        )
    }
}
