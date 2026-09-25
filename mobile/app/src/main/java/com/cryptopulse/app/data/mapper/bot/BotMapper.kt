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
    positionSize = positionSize,
    entryIntent = entryIntent
)

fun StrategyMetadataDto.toDomain(): StrategyMetadata = StrategyMetadata(
    strategyId = strategyId ?: "",
    displayName = displayName ?: (strategyId ?: ""),
    primaryTimeframe = primaryTimeframe ?: "15m",
    timeframesAnalyzed = timeframesAnalyzed?.filterNotNull() ?: listOf("15m"),
    category = category ?: "Trading",
    riskProfile = riskProfile ?: "Medium",
    parameters = parameters?.filterNotNull()?.map { StrategyParameter(it.key ?: "", it.label ?: "", it.value ?: "") } ?: emptyList(),
    factorContributions = factorContributions?.filterNotNull()?.map { FactorContribution(it.factor ?: "", it.weight ?: 25, it.score ?: 50, it.level ?: "MEDIUM") } ?: emptyList()
)

fun AnalysisSnapshotDto.toDomain(): AnalysisSnapshot = AnalysisSnapshot(
    engineStatus = (engineStatus?.let { e -> 
        EngineStatusDTO(e.state ?: "ANALYSING", e.activeStrategy, e.lastEvaluationTimestamp ?: System.currentTimeMillis(), e.nextEvaluationTime ?: 0L, e.health ?: "OK") 
    }) ?: EngineStatusDTO("ACTIVE", null, System.currentTimeMillis(), 0L, "OK"),
    marketAnalysis = (marketAnalysis?.let { m -> 
        MarketAnalysisDTO(
            symbol = m.symbol ?: "BTCUSDT",
            timeframeStatus = m.timeframeStatus ?: "ALIGNED",
            indicatorSummary = m.indicatorSummary?.filterNotNull()?.map { IndicatorSummary(it.name ?: "", it.value ?: "", it.signal ?: "NEUTRAL") } ?: emptyList(),
            conditionSummary = m.conditionSummary?.filterNotNull()?.map { ConditionSummary(it.id ?: "", it.name ?: "", it.currentValue ?: "", it.targetValue ?: "", it.status ?: "PENDING") } ?: emptyList(),
            confidenceScore = m.confidenceScore ?: 50,
            confidenceExplanation = m.confidenceExplanation?.filterNotNull() ?: emptyList(),
            requiredScore = m.requiredScore ?: requiredScore
        ) 
    }) ?: MarketAnalysisDTO("BTCUSDT", "ALIGNED", emptyList(), emptyList(), 50, emptyList(), requiredScore = requiredScore),
    tradingSignal = tradingSignal?.let { s -> 
        if (s.type == "BUY" || s.type == "SELL") {
            SignalDTO(
                type = s.type,
                entryContext = s.entryContext ?: "NONE",
                signalPrice = s.signalPrice ?: 0.0,
                targetEntryPrice = s.targetEntryPrice ?: 0.0,
                stopLoss = s.stopLoss ?: 0.0,
                takeProfit = s.takeProfit ?: 0.0,
                riskClassification = s.riskClassification ?: "MEDIUM",
                reasoning = s.reasoning?.filterNotNull() ?: emptyList()
            )
        } else {
            null
        }
    },
    opportunity = opportunity?.toDomain(),
    strategyMetadata = strategyMetadata?.toDomain(),
    requiredScore = requiredScore ?: marketAnalysis?.requiredScore
)

fun TradeExecutionStatusDto.toDomain(): TradeExecutionResult = TradeExecutionResult(
    positionId = positionId ?: alertId ?: "",
    alertId = alertId ?: positionId ?: "",
    orderId = orderId ?: "",
    symbol = symbol ?: "",
    side = side ?: "BUY",
    strategy = strategy ?: "",
    exchange = exchange ?: "bybit",
    environment = environment ?: "mainnet",
    orderType = orderType ?: "MARKET",
    status = status ?: "PENDING_ENTRY",
    entryStatus = entryStatus ?: "PENDING_ENTRY",
    requestedEntryPrice = targetEntryPrice ?: signalPrice ?: 0.0,
    actualFillPrice = actualFillPrice ?: 0.0,
    requestedQuantity = requestedQuantity ?: 0.0,
    actualFilledQuantity = filledQuantity ?: 0.0,
    remainingQuantity = remainingQuantity ?: 0.0,
    stopLoss = stopLoss ?: 0.0,
    takeProfit = takeProfit ?: 0.0,
    slippagePercent = slippagePercent ?: 0.0,
    submittedAt = submittedAt ?: "",
    executedAt = executedAt ?: "",
    isFilled = isFilled,
    isMockTrade = false
)

fun ExecuteTradeResponseDto.toDomain(fallbackAlertId: String): TradeExecutionResult = TradeExecutionResult(
    positionId = positionId ?: alertId ?: fallbackAlertId,
    alertId = alertId ?: positionId ?: fallbackAlertId,
    orderId = orderId ?: "",
    symbol = symbol ?: "",
    side = side ?: "BUY",
    strategy = "",
    exchange = "bybit",
    environment = "demo",
    orderType = "MARKET",
    status = if (success) "PENDING_ENTRY" else "FAILED",
    entryStatus = if (success) "PENDING_ENTRY" else "FAILED",
    requestedEntryPrice = executionPrice ?: 0.0,
    actualFillPrice = executionPrice ?: 0.0,
    requestedQuantity = quantity ?: 0.0,
    actualFilledQuantity = quantity ?: 0.0,
    remainingQuantity = 0.0,
    stopLoss = stopLoss ?: 0.0,
    takeProfit = takeProfit ?: 0.0,
    slippagePercent = 0.0,
    submittedAt = executedAt ?: "",
    executedAt = executedAt ?: "",
    isFilled = status == "filled" || status == "FILLED" || status == "closed" || status == "CLOSED",
    isMockTrade = false,
    success = this.success,
    message = this.message
)

