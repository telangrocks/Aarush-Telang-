package com.cryptopulse.app.data.mapper

import com.cryptopulse.app.data.api.dto.market.response.MarketCandidateDto
import com.cryptopulse.app.data.mapper.market.toDomain
import org.junit.Assert.assertEquals
import org.junit.Test

class MarketMapperTest {

    @Test
    fun `toDomain maps all 13 fields correctly when DTO is fully populated`() {
        val dto = MarketCandidateDto(
            rank = 1,
            symbol = "ADA",
            pairName = "ADA/USDT",
            currentMarketPrice = 0.1863,
            volume24h = 27208904.5,
            quoteVolume24h = 4769496.04,
            priceChange24h = 0.0144,
            priceChangePercent24h = 8.377,
            highPrice24h = 0.1876,
            lowPrice24h = 0.1697,
            score = 133.77,
            minNotional = 5.0,
            tradeSide = "BUY"
        )

        val domain = dto.toDomain()

        assertEquals(1, domain.rank)
        assertEquals("ADA", domain.symbol)
        assertEquals("ADA/USDT", domain.pairName)
        assertEquals(0.1863, domain.currentMarketPrice, 0.0001)
        assertEquals(27208904.5, domain.volume24h, 0.1)
        assertEquals(4769496.04, domain.quoteVolume24h, 0.1)
        assertEquals(0.0144, domain.priceChange24h, 0.0001)
        assertEquals(8.377, domain.priceChangePercent24h, 0.001)
        assertEquals(0.1876, domain.highPrice24h, 0.0001)
        assertEquals(0.1697, domain.lowPrice24h, 0.0001)
        assertEquals(133.77, domain.score, 0.01)
        assertEquals(5.0, domain.minNotional ?: 0.0, 0.01)
        assertEquals("BUY", domain.tradeSide)
    }

    @Test
    fun `toDomain handles null fields with safe defaults`() {
        val dto = MarketCandidateDto()

        val domain = dto.toDomain()

        assertEquals(0, domain.rank)
        assertEquals("UNKNOWN", domain.symbol)
        assertEquals("UNKNOWN/USDT", domain.pairName)
        assertEquals(0.0, domain.currentMarketPrice, 0.0)
        assertEquals(0.0, domain.volume24h, 0.0)
        assertEquals(0.0, domain.quoteVolume24h, 0.0)
        assertEquals(0.0, domain.highPrice24h, 0.0)
        assertEquals(0.0, domain.lowPrice24h, 0.0)
        assertEquals(0.0, domain.score, 0.0)
        assertEquals(null, domain.minNotional)
        assertEquals("NEUTRAL", domain.tradeSide)
    }
}
