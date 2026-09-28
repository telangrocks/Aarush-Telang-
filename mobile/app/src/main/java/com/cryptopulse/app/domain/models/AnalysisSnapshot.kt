package com.cryptopulse.app.domain.models

import androidx.compose.runtime.Immutable

@Immutable
data class FactorContribution(
    val factor: String,
    val weight: Int,
    val score: Int,
    val level: String
)

@Immutable
data class StrategyParameter(
    val key: String,
    val label: String,
    val value: String
)

@Immutable
data class StrategyMetadata(
    val strategyId: String,
    val displayName: String,
    val primaryTimeframe: String,
    val timeframesAnalyzed: List<String>,
    val category: String,
    val riskProfile: String,
    val parameters: List<StrategyParameter>,
    val factorContributions: List<FactorContribution>
)

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
    val confidenceExplanation: List<String>?,
    val requiredScore: Int? = null
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
data class StrategyEvaluation(
    val strategyId: String,
    val confidenceScore: Int?,
    val requiredScore: Int? = null,
    val hasSignal: Boolean,
    val signalType: String?,
    val qualificationStatus: String,
    val timestamp: Long,
    val reasoning: List<String> = emptyList()
)

@Immutable
data class AnalysisSnapshot(
    val engineStatus: EngineStatusDTO?,
    val marketAnalysis: MarketAnalysisDTO?,
    val tradingSignal: SignalDTO?,
    val opportunity: BotAlert?,
    val strategyMetadata: StrategyMetadata? = null,
    val requiredScore: Int? = null,
    val strategyAnalyses: List<StrategyEvaluation> = emptyList()
) {
    val symbol: String?
        get() = marketAnalysis?.symbol ?: opportunity?.symbol
}

