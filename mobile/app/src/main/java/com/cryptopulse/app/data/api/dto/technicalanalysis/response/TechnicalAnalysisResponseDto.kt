package com.cryptopulse.app.data.api.dto.technicalanalysis.response

import com.cryptopulse.app.data.api.dto.bot.response.EngineStatusDto
import com.cryptopulse.app.data.api.dto.bot.response.MarketAnalysisDto
import com.cryptopulse.app.data.api.dto.bot.response.SignalDto
import com.cryptopulse.app.data.api.dto.bot.response.StrategyMetadataDto

data class CheckpointDto(
    val name: String? = null,
    val status: String? = null
)

data class TechnicalAnalysisResponseDto(
    val symbol: String? = null,
    val strategy: String? = null,
    val price: Double? = null,
    val change24h: Double? = null,
    val volume: Double? = null,
    val high24h: Double? = null,
    val low24h: Double? = null,
    val indicators: Map<String, Any>? = null,
    val signals: Map<String, Any>? = null,
    val checkpoints: List<CheckpointDto>? = null,
    val progress: Int? = null,
    val conditionsMet: List<String>? = null,
    val opportunity: Map<String, Any>? = null,
    val timestamp: String? = null,
    val engineStatus: EngineStatusDto? = null,
    val marketAnalysis: MarketAnalysisDto? = null,
    val tradingSignal: SignalDto? = null,
    val strategyMetadata: StrategyMetadataDto? = null
)

