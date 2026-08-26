package com.cryptopulse.app.data.mapper.technicalanalysis

import com.cryptopulse.app.data.api.dto.technicalanalysis.response.TechnicalAnalysisResponseDto
import com.cryptopulse.app.data.api.dto.technicalanalysis.response.CheckpointDto
import com.cryptopulse.app.data.api.dto.bot.response.AnalysisSnapshotDto
import com.cryptopulse.app.data.mapper.bot.toDomain
import com.cryptopulse.app.domain.models.AnalysisSnapshot
import com.cryptopulse.app.domain.models.TechnicalAnalysisResult
import com.cryptopulse.app.domain.models.Checkpoint
import com.cryptopulse.app.domain.models.BotAlert

fun TechnicalAnalysisResponseDto.toDomain(): TechnicalAnalysisResult = TechnicalAnalysisResult(
    symbol = symbol,
    strategy = strategy,
    price = price,
    change24h = change24h,
    volume = volume,
    high24h = high24h,
    low24h = low24h,
    indicators = indicators,
    signals = signals,
    checkpoints = checkpoints.map { it.toDomain() },
    progress = progress,
    conditionsMet = conditionsMet,
    opportunity = opportunity,
    timestamp = timestamp
)

fun TechnicalAnalysisResponseDto.toAnalysisSnapshot(): AnalysisSnapshot {
    val snapshotDto = AnalysisSnapshotDto(
        engineStatus = engineStatus,
        marketAnalysis = marketAnalysis,
        tradingSignal = tradingSignal,
        strategyMetadata = strategyMetadata
    )
    val domainSnapshot = snapshotDto.toDomain()
    val domainOpportunity = opportunity?.let { BotAlert.fromMap(it) }
    return domainSnapshot.copy(opportunity = domainOpportunity)
}

fun CheckpointDto.toDomain(): Checkpoint = Checkpoint(
    name = name,
    status = status
)
