package com.cryptopulse.app.domain.models

data class TechnicalAnalysisResult(
    val symbol: String,
    val strategy: String,
    val price: Double,
    val change24h: Double,
    val volume: Double,
    val high24h: Double,
    val low24h: Double,
    val progress: Int,
    val conditionsMet: List<String>,
    val timestamp: String,
    val indicators: Map<String, Any> = emptyMap(),
    val signals: Map<String, Any> = emptyMap(),
    val opportunity: Map<String, Any>? = null,
    val checkpoints: List<Checkpoint> = emptyList()
)

data class Checkpoint(
    val name: String,
    val status: String
)
