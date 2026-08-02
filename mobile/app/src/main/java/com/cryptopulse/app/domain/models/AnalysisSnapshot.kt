package com.cryptopulse.app.domain.models

import androidx.compose.runtime.Immutable

@Immutable
data class EngineStatusDTO(
    val state: String?,
    val activeStrategy: String?,
    val lastEvaluationTimestamp: Long?,
    val nextEvaluationTime: Long?,
    val health: String?
)

@Immutable
data class IndicatorSummary(
    val name: String,
    val value: String,
    val signal: String
)

@Immutable
data class ConditionSummary(
    val id: String,
    val name: String,
    val currentValue: String,
    val targetValue: String,
    val status: String
)

@Immutable
data class MarketAnalysisDTO(
    val symbol: String?,
    val timeframeStatus: String?,
    val indicatorSummary: List<IndicatorSummary>?,
    val conditionSummary: List<ConditionSummary>?,
    val confidenceScore: Int?,
    val confidenceExplanation: List<String>?
)

@Immutable
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

@Immutable
data class AnalysisSnapshot(
    val engineStatus: EngineStatusDTO?,
    val marketAnalysis: MarketAnalysisDTO?,
    val tradingSignal: SignalDTO?
)
