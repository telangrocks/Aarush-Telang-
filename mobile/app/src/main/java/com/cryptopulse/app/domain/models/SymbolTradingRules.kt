package com.cryptopulse.app.domain.models

data class ExchangeFilterConstraint(
    val filterType: String,
    val parameters: Map<String, Any> = emptyMap()
)

data class SymbolTradingRules(
    val schemaVersion: String = "2.0",
    val symbol: String,
    val exchange: String,
    val baseAsset: String,
    val quoteAsset: String,
    val minNotional: Double,
    val minQty: Double,
    val maxQty: Double,
    val stepSize: Double,
    val tickSize: Double,
    val minPrice: Double,
    val maxPrice: Double,
    val contractSize: Double = 1.0,
    val maxPosition: Double? = null,
    val additionalFilters: List<ExchangeFilterConstraint> = emptyList(),
    val lastUpdated: Long = System.currentTimeMillis()
)
