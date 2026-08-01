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
        EngineStatusDTO(e.state, e.activeStrategy, e.lastEvaluationTimestamp, e.nextEvaluationTime, e.health) 
    },
    marketAnalysis = marketAnalysis?.let { m -> 
        MarketAnalysisDTO(
            symbol = m.symbol,
            timeframeStatus = m.timeframeStatus,
            indicatorSummary = m.indicatorSummary?.map { IndicatorSummary(it.name, it.value, it.signal) },
            conditionSummary = m.conditionSummary?.map { ConditionSummary(it.id, it.name, it.currentValue, it.targetValue, it.status) },
            confidenceScore = m.confidenceScore,
            confidenceExplanation = m.confidenceExplanation
        ) 
    },
    tradingSignal = tradingSignal?.let { s -> 
        SignalDTO(s.type, s.entryContext, s.signalPrice, s.targetEntryPrice, s.stopLoss, s.takeProfit, s.riskClassification, s.reasoning) 
    }
)
