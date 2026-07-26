package com.cryptopulse.app.domain.utils

import java.util.Locale

data class ResolvedSymbol(
    val symbol: String,
    val baseAsset: String,
    val quoteAsset: String
)

object SymbolResolver {
    private val KNOWN_QUOTES = listOf("USDT", "BUSD", "USD", "USDC", "BTC", "ETH")

    fun resolve(inputSymbol: String, defaultQuote: String = "USDT"): ResolvedSymbol {
        require(inputSymbol.isNotBlank()) { "Invalid symbol input: must be a non-empty string." }

        val cleaned = inputSymbol.trim().uppercase(Locale.ROOT).replace(Regex("[/\\s\\-_]"), "")

        for (quote in KNOWN_QUOTES) {
            if (cleaned.endsWith(quote) && cleaned.length > quote.length) {
                val base = cleaned.substring(0, cleaned.length - quote.length)
                return ResolvedSymbol(
                    symbol = cleaned,
                    baseAsset = base,
                    quoteAsset = quote
                )
            }
        }

        val quote = defaultQuote.uppercase(Locale.ROOT)
        return ResolvedSymbol(
            symbol = "$cleaned$quote",
            baseAsset = cleaned,
            quoteAsset = quote
        )
    }

    fun toCacheKey(inputSymbol: String, defaultQuote: String = "USDT"): String {
        return resolve(inputSymbol, defaultQuote).symbol
    }
}
