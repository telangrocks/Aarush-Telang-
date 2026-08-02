package com.cryptopulse.app.data.api.dto.bot.response

data class IndicatorSummaryDto(
    val name: String? = null,
    val value: String? = null,
    val signal: String? = null
)

data class ConditionSummaryDto(
    val id: String? = null,
    val name: String? = null,
    val currentValue: String? = null,
    val targetValue: String? = null,
    val status: String? = null
)

data class EngineStatusDto(
    val state: String? = null,
    val activeStrategy: String? = null,
    val lastEvaluationTimestamp: Long? = null,
    val nextEvaluationTime: Long? = null,
    val health: String? = null
)

data class MarketAnalysisDto(
    val symbol: String? = null,
    val timeframeStatus: String? = null,
    val indicatorSummary: List<IndicatorSummaryDto>? = null,
    val conditionSummary: List<ConditionSummaryDto>? = null,
    val confidenceScore: Int? = null,
    val confidenceExplanation: List<String>? = null
)

data class SignalDto(
    val type: String? = null,
    val entryContext: String? = null,
    val signalPrice: Double? = null,
    val targetEntryPrice: Double? = null,
    val stopLoss: Double? = null,
    val takeProfit: Double? = null,
    val riskClassification: String? = null,
    val reasoning: List<String>? = null
)

data class AnalysisSnapshotDto(
    val engineStatus: EngineStatusDto? = null,
    val marketAnalysis: MarketAnalysisDto? = null,
    val tradingSignal: SignalDto? = null
)
