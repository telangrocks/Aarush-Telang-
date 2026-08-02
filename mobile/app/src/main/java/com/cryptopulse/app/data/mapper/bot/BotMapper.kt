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
    targetEntryPrice = targetEntryPrice
)

fun AnalysisSnapshotDto.toDomain(): AnalysisSnapshot = AnalysisSnapshot(
    engineStatus = engineStatus?.let { e -> 
        EngineStatusDTO(e.state ?: "ANALYSING", e.activeStrategy ?: "NONE", e.lastEvaluationTimestamp ?: 0L, e.nextEvaluationTime ?: 0L, e.health ?: "OK") 
    },
    marketAnalysis = marketAnalysis?.let { m -> 
        MarketAnalysisDTO(
            symbol = m.symbol ?: "BTCUSDT",
            timeframeStatus = m.timeframeStatus ?: "",
            indicatorSummary = m.indicatorSummary?.map { IndicatorSummary(it.name ?: "", it.value ?: "", it.signal ?: "HOLD") } ?: emptyList(),
            conditionSummary = m.conditionSummary?.map { ConditionSummary(it.id ?: "", it.name ?: "", it.currentValue ?: "", it.targetValue ?: "", it.status ?: "PENDING") } ?: emptyList(),
            confidenceScore = m.confidenceScore ?: 0,
            confidenceExplanation = m.confidenceExplanation ?: emptyList()
        ) 
    },
    tradingSignal = tradingSignal?.let { s -> 
        SignalDTO(s.type ?: "HOLD", s.entryContext ?: "NONE", s.signalPrice ?: 0.0, s.targetEntryPrice ?: 0.0, s.stopLoss ?: 0.0, s.takeProfit ?: 0.0, s.riskClassification ?: "MEDIUM", s.reasoning ?: emptyList()) 
    }
)
