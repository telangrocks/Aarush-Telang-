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
    strategyId = strategyId ?: "ScalperV2",
    displayName = displayName ?: "Scalper V2",
    primaryTimeframe = primaryTimeframe ?: "15m",
    timeframesAnalyzed = timeframesAnalyzed?.filterNotNull() ?: listOf("15m"),
    category = category ?: "Trading",
    riskProfile = riskProfile ?: "Medium",
    parameters = parameters?.filterNotNull()?.map { StrategyParameter(it.key ?: "", it.label ?: "", it.value ?: "") } ?: emptyList(),
    factorContributions = factorContributions?.filterNotNull()?.map { FactorContribution(it.factor ?: "", it.weight ?: 25, it.score ?: 50, it.level ?: "MEDIUM") } ?: emptyList()
)

fun AnalysisSnapshotDto.toDomain(): AnalysisSnapshot = AnalysisSnapshot(
    engineStatus = (engineStatus?.let { e -> 
        EngineStatusDTO(e.state ?: "ANALYSING", e.activeStrategy ?: "ScalperV2", e.lastEvaluationTimestamp ?: System.currentTimeMillis(), e.nextEvaluationTime ?: 0L, e.health ?: "OK") 
    }) ?: EngineStatusDTO("ACTIVE", "ScalperV2", System.currentTimeMillis(), 0L, "OK"),
    marketAnalysis = (marketAnalysis?.let { m -> 
        MarketAnalysisDTO(
            symbol = m.symbol ?: "BTCUSDT",
            timeframeStatus = m.timeframeStatus ?: "ALIGNED",
            indicatorSummary = m.indicatorSummary?.filterNotNull()?.map { IndicatorSummary(it.name ?: "", it.value ?: "", it.signal ?: "HOLD") } ?: emptyList(),
            conditionSummary = m.conditionSummary?.filterNotNull()?.map { ConditionSummary(it.id ?: "", it.name ?: "", it.currentValue ?: "", it.targetValue ?: "", it.status ?: "PENDING") } ?: emptyList(),
            confidenceScore = m.confidenceScore ?: 50,
            confidenceExplanation = m.confidenceExplanation?.filterNotNull() ?: emptyList()
        ) 
    }) ?: MarketAnalysisDTO("BTCUSDT", "ALIGNED", emptyList(), emptyList(), 50, emptyList()),
    tradingSignal = (tradingSignal?.let { s -> 
        SignalDTO(s.type ?: "HOLD", s.entryContext ?: "NONE", s.signalPrice ?: 0.0, s.targetEntryPrice ?: 0.0, s.stopLoss ?: 0.0, s.takeProfit ?: 0.0, s.riskClassification ?: "MEDIUM", s.reasoning?.filterNotNull() ?: emptyList()) 
    }) ?: SignalDTO("HOLD", "NONE", 0.0, 0.0, 0.0, 0.0, "MEDIUM", emptyList()),
    opportunity = opportunity?.toDomain(),
    strategyMetadata = strategyMetadata?.toDomain()
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
    status = "PENDING_ENTRY",
    entryStatus = "PENDING_ENTRY",
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
    isFilled = false,
    isMockTrade = false
)

