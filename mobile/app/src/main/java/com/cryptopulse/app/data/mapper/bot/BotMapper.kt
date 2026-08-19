package com.cryptopulse.app.data.mapper.bot

import com.cryptopulse.app.data.api.dto.bot.response.*
import com.cryptopulse.app.domain.models.*

fun BotAlertDto.toDomain(): BotAlert = BotAlert(
    id = id,
    symbol = symbol,
    entryPrice = entryPrice,
    stopLoss = stopLoss,
    takeProfit = takeProfit,
    estimatedPnl = estimatedPnl,
    strategy = strategy,
    side = side,
    timestamp = timestamp,
    signalPrice = signalPrice,
    targetEntryPrice = targetEntryPrice,
    positionSize = positionSize
)

fun AnalysisSnapshotDto.toDomain(): AnalysisSnapshot = AnalysisSnapshot(
    engineStatus = (engineStatus?.let { e -> 
        EngineStatusDTO(e.state ?: "ANALYSING", e.activeStrategy ?: "ScalperV2", e.lastEvaluationTimestamp ?: System.currentTimeMillis(), e.nextEvaluationTime ?: 0L, e.health ?: "OK") 
    }) ?: EngineStatusDTO("ACTIVE", "ScalperV2", System.currentTimeMillis(), 0L, "OK"),
    marketAnalysis = (marketAnalysis?.let { m -> 
        MarketAnalysisDTO(
            symbol = m.symbol ?: "BTCUSDT",
            timeframeStatus = m.timeframeStatus ?: "ALIGNED",
            indicatorSummary = m.indicatorSummary?.map { IndicatorSummary(it.name ?: "", it.value ?: "", it.signal ?: "HOLD") } ?: emptyList(),
            conditionSummary = m.conditionSummary?.map { ConditionSummary(it.id ?: "", it.name ?: "", it.currentValue ?: "", it.targetValue ?: "", it.status ?: "PENDING") } ?: emptyList(),
            confidenceScore = m.confidenceScore ?: 50,
            confidenceExplanation = m.confidenceExplanation ?: emptyList()
        ) 
    }) ?: MarketAnalysisDTO("BTCUSDT", "ALIGNED", emptyList(), emptyList(), 50, emptyList()),
    tradingSignal = (tradingSignal?.let { s -> 
        SignalDTO(s.type ?: "HOLD", s.entryContext ?: "NONE", s.signalPrice ?: 0.0, s.targetEntryPrice ?: 0.0, s.stopLoss ?: 0.0, s.takeProfit ?: 0.0, s.riskClassification ?: "MEDIUM", s.reasoning ?: emptyList()) 
    }),
    opportunity = opportunity?.toDomain()
)
