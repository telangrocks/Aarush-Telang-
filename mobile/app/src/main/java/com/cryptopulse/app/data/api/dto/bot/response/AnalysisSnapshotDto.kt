package com.cryptopulse.app.data.api.dto.bot.response

data class IndicatorSummaryDto(
    val name: String,
    val value: String,
    val signal: String
)

data class ConditionSummaryDto(
    val id: String,
    val name: String,
    val currentValue: String,
    val targetValue: String,
    val status: String
)

data class EngineStatusDto(
    val state: String?,
    val activeStrategy: String?,
    val lastEvaluationTimestamp: Long?,
    val nextEvaluationTime: Long?,
    val health: String?
)

data class MarketAnalysisDto(
    val symbol: String?,
    val timeframeStatus: String?,
    val indicatorSummary: List<IndicatorSummaryDto>?,
    val conditionSummary: List<ConditionSummaryDto>?,
    val confidenceScore: Int?,
    val confidenceExplanation: List<String>?
)

data class SignalDto(
    val type: String?,
    val entryContext: String?,
    val signalPrice: Double?,
    val targetEntryPrice: Double?,
    val stopLoss: Double?,
    val takeProfit: Double?,
    val riskClassification: String?,
    val reasoning: List<String>?
)

data class AnalysisSnapshotDto(
    val engineStatus: EngineStatusDto?,
    val marketAnalysis: MarketAnalysisDto?,
    val tradingSignal: SignalDto?
)
