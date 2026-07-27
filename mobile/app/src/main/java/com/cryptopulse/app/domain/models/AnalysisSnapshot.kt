package com.cryptopulse.app.domain.models

data class EngineStatusDTO(
    val state: String?,
    val activeStrategy: String?,
    val lastEvaluationTimestamp: Long?,
    val nextEvaluationTime: Long?,
    val health: String?
)

data class IndicatorSummary(
    val name: String,
    val value: String,
    val signal: String
)

data class ConditionSummary(
    val id: String,
    val name: String,
    val currentValue: String,
    val targetValue: String,
    val status: String
)

data class MarketAnalysisDTO(
    val symbol: String?,
    val timeframeStatus: String?,
    val indicatorSummary: List<IndicatorSummary>?,
    val conditionSummary: List<ConditionSummary>?,
    val confidenceScore: Int?,
    val confidenceExplanation: List<String>?
)

data class SignalDTO(
    val type: String?,
    val entryContext: String?,
    val signalPrice: Double?,
    val targetEntryPrice: Double?,
    val stopLoss: Double?,
    val takeProfit: Double?,
    val riskClassification: String?,
    val reasoning: List<String>?
)

data class AnalysisSnapshot(
    val engineStatus: EngineStatusDTO?,
    val marketAnalysis: MarketAnalysisDTO?,
    val tradingSignal: SignalDTO?
)
