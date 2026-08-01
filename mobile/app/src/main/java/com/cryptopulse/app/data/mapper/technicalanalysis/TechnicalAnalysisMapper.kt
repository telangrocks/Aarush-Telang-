package com.cryptopulse.app.data.mapper.technicalanalysis

import com.cryptopulse.app.data.api.dto.technicalanalysis.response.TechnicalAnalysisResponseDto
import com.cryptopulse.app.data.api.dto.technicalanalysis.response.CheckpointDto
import com.cryptopulse.app.domain.models.TechnicalAnalysisResult
import com.cryptopulse.app.domain.models.Checkpoint

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

fun CheckpointDto.toDomain(): Checkpoint = Checkpoint(
    name = name,
    status = status
)

