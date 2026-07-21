package com.cryptopulse.app.domain.models

enum class StrategyCategory {
    INTRADAY, SWING, SCALPING, GRID, ARBITRAGE, CUSTOM
}

enum class RiskLevel {
    LOW, MEDIUM, HIGH
}

enum class ParameterType {
    INT, DOUBLE, BOOLEAN, ENUM
}

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

data class Strategy(
    val id: String,
    val name: String,
    val description: String,
    val category: StrategyCategory,
    val riskLevel: RiskLevel,
    val schemaVersion: Int,
    val requiredParameters: List<StrategyParameterSchema>
)
