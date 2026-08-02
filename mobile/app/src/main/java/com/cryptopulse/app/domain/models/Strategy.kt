package com.cryptopulse.app.domain.models

import androidx.compose.runtime.Immutable

enum class StrategyCategory {
    SCALPING, SWING, INTRADAY, GRID, ARBITRAGE, CUSTOM,
    TREND_FOLLOWING, BREAKOUT, MEAN_REVERSION, VWAP
}

enum class RiskLevel {
    LOW, MEDIUM, HIGH
}

enum class ParameterType {
    INT, DOUBLE, BOOLEAN, ENUM
}

@Immutable
data class StrategyParameterSchema(
    val key: String,
    val displayName: String,
    val type: ParameterType,
    val defaultValue: String,
    val isRequired: Boolean,
    val minValue: Double? = null,
    val maxValue: Double? = null,
    val options: List<String>? = null
)

@Immutable
data class Strategy(
    val id: String,
    val name: String,
    val description: String,
    val category: StrategyCategory,
    val riskLevel: RiskLevel,
    val schemaVersion: Int,
    val version: String = "1.0",
    val supportedMarkets: List<String> = emptyList(),
    val supportedTimeframes: List<String> = emptyList(),
    val minimumCandles: Int = 0,
    val supportsLong: Boolean = true,
    val supportsShort: Boolean = true,
    val supportsPaperTrading: Boolean = true,
    val supportsLiveTrading: Boolean = true,
    val status: String = "ACTIVE",
    val author: String = "CryptoPulse Core",
    val requiredParameters: List<StrategyParameterSchema>
)
