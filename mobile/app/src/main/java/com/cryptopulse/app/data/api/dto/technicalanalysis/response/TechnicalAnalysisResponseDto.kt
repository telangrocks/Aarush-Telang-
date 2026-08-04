package com.cryptopulse.app.data.api.dto.technicalanalysis.response

import com.cryptopulse.app.data.api.dto.bot.response.EngineStatusDto
import com.cryptopulse.app.data.api.dto.bot.response.MarketAnalysisDto
import com.cryptopulse.app.data.api.dto.bot.response.SignalDto

data class CheckpointDto(val name: String, val status: String)

data class TechnicalAnalysisResponseDto(
    val symbol: String,
    val strategy: String,
    val price: Double,
    val change24h: Double,
    val volume: Double,
    val high24h: Double,
    val low24h: Double,
    val indicators: Map<String, Any>,
    val signals: Map<String, Any>,
    val checkpoints: List<CheckpointDto>,
    val progress: Int,
    val conditionsMet: List<String>,
    val opportunity: Map<String, Any>?,
    val timestamp: String,
    val engineStatus: EngineStatusDto? = null,
    val marketAnalysis: MarketAnalysisDto? = null,
    val tradingSignal: SignalDto? = null
)
