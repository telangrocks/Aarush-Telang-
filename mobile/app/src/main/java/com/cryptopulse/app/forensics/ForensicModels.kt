package com.cryptopulse.app.forensics

import com.google.gson.annotations.SerializedName

/**
 * Canonical Error Classifications for ShrikantTelang_ForensicCID.
 */
enum class ForensicErrorCategory {
    DATA_ERROR,
    DATA_STALE,
    VALIDATION_ERROR,
    INDICATOR_ERROR,
    STRATEGY_ERROR,
    SCORE_ERROR,
    QUALIFICATION_ERROR,
    SIGNAL_ERROR,
    API_ERROR,
    TIMEOUT,
    NULL_VALUE,
    NAN_VALUE,
    PIPELINE_GAP,
    MISSING_DEPENDENCY,
    UNEXPECTED_STATE,
    PERFORMANCE_ANOMALY,
    CRASH,
    UNKNOWN_ERROR
}

data class ForensicErrorItem(
    @SerializedName("category") val category: ForensicErrorCategory,
    @SerializedName("source_component") val sourceComponent: String,
    @SerializedName("message") val message: String,
    @SerializedName("details") val details: String? = null,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis()
)

data class MarketDataForensic(
    @SerializedName("symbol") val symbol: String? = null,
    @SerializedName("timeframe") val timeframe: String? = null,
    @SerializedName("exchange") val exchange: String? = null,
    @SerializedName("current_price") val currentPrice: Double? = null,
    @SerializedName("change_24h") val change24h: Double? = null,
    @SerializedName("volume_24h") val volume24h: Double? = null,
    @SerializedName("high_24h") val high24h: Double? = null,
    @SerializedName("low_24h") val low24h: Double? = null,
    @SerializedName("candle_count_received") val candleCountReceived: Int? = null,
    @SerializedName("market_data_age_ms") val marketDataAgeMs: Long? = null,
    @SerializedName("latest_candle_timestamp") val latestCandleTimestamp: Long? = null,
    @SerializedName("missing_candles_detected") val missingCandlesDetected: Boolean = false,
    @SerializedName("malformed_data_detected") val malformedDataDetected: Boolean = false,
    @SerializedName("validation_result") val validationResult: String = "VALID", // "VALID", "INVALID", "NOT_AVAILABLE"
    @SerializedName("validation_rejection_reason") val validationRejectionReason: String? = null
)

data class IndicatorForensic(
    @SerializedName("indicator_name") val indicatorName: String,
    @SerializedName("value") val value: String? = null,
    @SerializedName("numeric_value") val numericValue: Double? = null,
    @SerializedName("signal") val signal: String? = null,
    @SerializedName("calculation_attempted") val calculationAttempted: Boolean = true,
    @SerializedName("calculation_completed") val calculationCompleted: Boolean = true,
    @SerializedName("is_valid") val isValid: Boolean = true,
    @SerializedName("status") val status: String = "VALID", // "VALID", "INVALID", "UNAVAILABLE", "ERROR", "ABNORMAL"
    @SerializedName("abnormal_flag") val abnormalFlag: String? = null,
    @SerializedName("error_detail") val errorDetail: String? = null
)

data class StrategyForensic(
    @SerializedName("strategy_name") val strategyName: String,
    @SerializedName("execution_started") val executionStarted: Boolean = true,
    @SerializedName("execution_completed") val executionCompleted: Boolean = true,
    @SerializedName("duration_ms") val durationMs: Long? = null,
    @SerializedName("raw_result") val rawResult: String? = null, // "BUY", "SELL", "NEUTRAL"
    @SerializedName("confidence_score") val confidenceScore: Int? = null,
    @SerializedName("conditions_evaluated") val conditionsEvaluated: List<String> = emptyList(),
    @SerializedName("conditions_passed") val conditionsPassed: List<String> = emptyList(),
    @SerializedName("conditions_failed") val conditionsFailed: List<String> = emptyList(),
    @SerializedName("rejection_reason") val rejectionReason: String? = null,
    @SerializedName("contributed_to_decision") val contributedToDecision: Boolean = false
)

data class ScoreFactorContribution(
    @SerializedName("factor") val factor: String,
    @SerializedName("weight") val weight: Int? = null,
    @SerializedName("score") val score: Int? = null,
    @SerializedName("level") val level: String? = null,
    @SerializedName("delta") val delta: Int? = null
)

data class ScoreProgression(
    @SerializedName("initial_score") val initialScore: Int = 50,
    @SerializedName("factor_contributions") val factorContributions: List<ScoreFactorContribution> = emptyList(),
    @SerializedName("final_score") val finalScore: Int = 50,
    @SerializedName("required_score") val requiredScore: Int = 70,
    @SerializedName("score_gap") val scoreGap: Int = 0,
    @SerializedName("significant_change") val significantChange: Boolean = false,
    @SerializedName("score_change_delta") val scoreChangeDelta: Int? = null
)

data class QualificationForensic(
    @SerializedName("qualification_attempted") val qualificationAttempted: Boolean = true,
    @SerializedName("qualification_result") val qualificationResult: String = "PENDING", // "PASSED", "FAILED", "PENDING", "NOT_AVAILABLE"
    @SerializedName("proposed_direction") val proposedDirection: String? = null,
    @SerializedName("required_score") val requiredScore: Int? = null,
    @SerializedName("actual_score") val actualScore: Int? = null,
    @SerializedName("conditions_passed") val conditionsPassed: List<String> = emptyList(),
    @SerializedName("conditions_failed") val conditionsFailed: List<String> = emptyList(),
    @SerializedName("exact_failure_reason") val exactFailureReason: String? = null,
    @SerializedName("final_rejection_reason") val finalRejectionReason: String? = null
)

data class SignalForensic(
    @SerializedName("signal_generated") val signalGenerated: Boolean = false,
    @SerializedName("signal_type") val signalType: String? = null, // "BUY", "SELL"
    @SerializedName("signal_price") val signalPrice: Double? = null,
    @SerializedName("target_entry_price") val targetEntryPrice: Double? = null,
    @SerializedName("stop_loss") val stopLoss: Double? = null,
    @SerializedName("take_profit") val takeProfit: Double? = null,
    @SerializedName("risk_reward_ratio") val riskRewardRatio: Double? = null,
    @SerializedName("position_size") val positionSize: Double? = null,
    @SerializedName("risk_classification") val riskClassification: String? = null,
    @SerializedName("evidence_chain") val evidenceChain: List<String> = emptyList(),
    @SerializedName("non_generation_category") val nonGenerationCategory: String? = null,
    @SerializedName("exact_non_generation_reason") val exactNonGenerationReason: String? = null
)

data class PipelineGapForensic(
    @SerializedName("gap_detected") val gapDetected: Boolean = false,
    @SerializedName("last_completed_stage") val lastCompletedStage: String? = null,
    @SerializedName("interrupted_at_stage") val interruptedAtStage: String? = null,
    @SerializedName("missing_strategies") val missingStrategies: List<String> = emptyList(),
    @SerializedName("gap_reason") val gapReason: String? = null
)

data class PerformanceForensic(
    @SerializedName("network_duration_ms") val networkDurationMs: Long? = null,
    @SerializedName("backend_duration_ms") val backendDurationMs: Long? = null,
    @SerializedName("client_duration_ms") val clientDurationMs: Long? = null,
    @SerializedName("total_cycle_duration_ms") val totalCycleDurationMs: Long? = null,
    @SerializedName("performance_anomaly") val performanceAnomaly: Boolean = false
)

/**
 * Top-Level Structured Forensic Record representing one complete Analysis Cycle.
 * Appended as one single-line JSON object in ShrikantTelang_ForensicCID.jsonl.
 */
data class ForensicCycleRecord(
    @SerializedName("record_type") val recordType: String = "ANALYSIS_CYCLE",
    @SerializedName("analysis_cycle_id") val analysisCycleId: String,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis(),
    @SerializedName("iso_timestamp") val isoTimestamp: String,
    @SerializedName("source") val source: String, // "BOT_POLL", "PREVIEW_POLL", "MANUAL_TRIGGER"
    @SerializedName("active_strategy") val activeStrategy: String? = null,
    @SerializedName("engine_state") val engineState: String? = null,
    @SerializedName("pipeline_status") val pipelineStatus: String, // "COMPLETED", "PARTIAL", "FAILED"
    @SerializedName("pipeline_gap") val pipelineGap: PipelineGapForensic,
    @SerializedName("market_data") val marketData: MarketDataForensic,
    @SerializedName("indicators") val indicators: List<IndicatorForensic> = emptyList(),
    @SerializedName("strategies") val strategies: List<StrategyForensic> = emptyList(),
    @SerializedName("score_forensics") val scoreForensics: ScoreProgression,
    @SerializedName("qualification") val qualification: QualificationForensic,
    @SerializedName("signal") val signal: SignalForensic,
    @SerializedName("performance") val performance: PerformanceForensic,
    @SerializedName("errors") val errors: List<ForensicErrorItem> = emptyList(),
    @SerializedName("ui_state_match") val uiStateMatch: Boolean = true,
    @SerializedName("raw_dto_available") val rawDtoAvailable: Boolean = true
)

/**
 * Structured Record for Application Lifecycle, Restarts, Crashes, Network Interceptions.
 */
data class ForensicLifecycleRecord(
    @SerializedName("record_type") val recordType: String = "LIFECYCLE_EVENT",
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis(),
    @SerializedName("iso_timestamp") val isoTimestamp: String,
    @SerializedName("event_type") val eventType: String, // "APP_START", "APP_RESTART_UNCLEAN", "APP_FOREGROUND", "APP_BACKGROUND", "APP_STOP", "LOGGER_START", "LOGGER_STOP", "CRASH", "NETWORK_ERROR"
    @SerializedName("details") val details: Map<String, Any?> = emptyMap()
)

/**
 * Aggregated Summary persisted in ShrikantTelang_ForensicCID_Summary.json.
 */
data class ForensicSummary(
    @SerializedName("test_start_time") val testStartTime: String,
    @SerializedName("last_updated_time") var lastUpdatedTime: String,
    @SerializedName("total_analysis_cycles") var totalAnalysisCycles: Int = 0,
    @SerializedName("successful_cycles") var successfulCycles: Int = 0,
    @SerializedName("failed_cycles") var failedCycles: Int = 0,
    @SerializedName("total_signals_generated") var totalSignalsGenerated: Int = 0,
    @SerializedName("buy_signals") var buySignals: Int = 0,
    @SerializedName("sell_signals") var sellSignals: Int = 0,
    @Deprecated("HOLD signal removed across entire system")
    @SerializedName("hold_signals") var holdSignals: Int = 0,
    @SerializedName("total_rejected_setups") var totalRejectedSetups: Int = 0,
    @SerializedName("total_qualification_failures") var totalQualificationFailures: Int = 0,
    @SerializedName("total_pipeline_gaps") var totalPipelineGaps: Int = 0,
    @SerializedName("total_errors") var totalErrors: Int = 0,
    @SerializedName("errors_by_category") val errorsByCategory: MutableMap<String, Int> = mutableMapOf(),
    @SerializedName("strategy_execution_counts") val strategyExecutionCounts: MutableMap<String, Int> = mutableMapOf(),
    @SerializedName("strategy_failures") val strategyFailures: MutableMap<String, Int> = mutableMapOf(),
    @SerializedName("indicator_failures") val indicatorFailures: MutableMap<String, Int> = mutableMapOf(),
    @SerializedName("api_failures") var apiFailures: Int = 0,
    @SerializedName("longest_analysis_cycle_ms") var longestAnalysisCycleMs: Long = 0L,
    @SerializedName("abnormal_performance_events") var abnormalPerformanceEvents: Int = 0,
    @SerializedName("application_crashes") var applicationCrashes: Int = 0,
    @SerializedName("unclean_restarts") var uncleanRestarts: Int = 0
)

/**
 * CID (Continuous Investigation & Diagnostics) Canonical Classifications & Payloads.
 */
enum class CidCategory {
    LIFECYCLE,
    NAVIGATION,
    NETWORK,
    AUTH,
    EXCHANGE,
    BOT,
    CRASH
}

enum class CidSeverity {
    DEBUG,
    INFO,
    WARN,
    ERROR,
    CRITICAL
}

data class CidLifecyclePayload(
    @SerializedName("eventType") val eventType: String,
    @SerializedName("deviceModel") val deviceModel: String? = null,
    @SerializedName("osVersion") val osVersion: String? = null,
    @SerializedName("appVersion") val appVersion: String? = null,
    @SerializedName("batteryLevel") val batteryLevel: Float? = null,
    @SerializedName("memoryUsageMb") val memoryUsageMb: Long? = null,
    @SerializedName("cleanShutdown") val cleanShutdown: Boolean? = null,
    @SerializedName("lastHeartbeatTimestamp") val lastHeartbeatTimestamp: Long? = null,
    @SerializedName("gapDurationMs") val gapDurationMs: Long? = null,
    @SerializedName("reason") val reason: String? = null,
    @SerializedName("packageName") val packageName: String? = null,
    @SerializedName("pid") val pid: Int? = null
)

data class CidNavigationPayload(
    @SerializedName("fromRoute") val fromRoute: String? = null,
    @SerializedName("toRoute") val toRoute: String,
    @SerializedName("trigger") val trigger: String? = null
)

data class CidNetworkPayload(
    @SerializedName("method") val method: String,
    @SerializedName("path") val path: String,
    @SerializedName("statusCode") val statusCode: Int,
    @SerializedName("durationMs") val durationMs: Long,
    @SerializedName("contentLength") val contentLength: Long,
    @SerializedName("cfRay") val cfRay: String? = null,
    @SerializedName("error") val error: String? = null
)

data class CidAuthPayload(
    @SerializedName("action") val action: String,
    @SerializedName("success") val success: Boolean,
    @SerializedName("errorCode") val errorCode: String? = null
)

data class CidExchangePayload(
    @SerializedName("exchangeId") val exchangeId: String,
    @SerializedName("action") val action: String,
    @SerializedName("status") val status: String,
    @SerializedName("durationMs") val durationMs: Long? = null,
    @SerializedName("errorCode") val errorCode: String? = null,
    @SerializedName("orderType") val orderType: String? = null
)

data class CidBotPayload(
    @SerializedName("botId") val botId: String? = null,
    @SerializedName("symbol") val symbol: String? = null,
    @SerializedName("strategyId") val strategyId: String? = null,
    @SerializedName("cycleCount") val cycleCount: Int? = null,
    @SerializedName("signalType") val signalType: String? = null,
    @SerializedName("marketPrice") val marketPrice: Double? = null,
    @SerializedName("entryPrice") val entryPrice: Double? = null,
    @SerializedName("stopLoss") val stopLoss: Double? = null,
    @SerializedName("takeProfit") val takeProfit: Double? = null,
    @SerializedName("score") val score: Int? = null,
    @SerializedName("longScore") val longScore: Int? = null,
    @SerializedName("shortScore") val shortScore: Int? = null,
    @SerializedName("overallLongScore") val overallLongScore: Int? = null,
    @SerializedName("overallShortScore") val overallShortScore: Int? = null,
    @SerializedName("confidence") val confidence: Int? = null,
    @SerializedName("riskClassification") val riskClassification: String? = null,
    @SerializedName("rejectionReason") val rejectionReason: String? = null,
    @SerializedName("error") val error: String? = null
)

data class CidCrashPayload(
    @SerializedName("exceptionClass") val exceptionClass: String,
    @SerializedName("message") val message: String? = null,
    @SerializedName("stackTraceTop") val stackTraceTop: String? = null,
    @SerializedName("threadName") val threadName: String? = null,
    @SerializedName("fatal") val fatal: Boolean? = true
)

/**
 * Standard Wire DTO for CID Events dispatched to backend /api/cid/events.
 */
data class CidEventDto(
    @SerializedName("seq") val seq: Long,
    @SerializedName("timestamp") val timestamp: Long = System.currentTimeMillis(),
    @SerializedName("category") val category: String,
    @SerializedName("component") val component: String,
    @SerializedName("eventName") val eventName: String,
    @SerializedName("severity") val severity: String = "INFO",
    @SerializedName("durationMs") val durationMs: Long? = null,
    @SerializedName("correlationId") val correlationId: String? = null,
    @SerializedName("payload") val payload: Any? = null
)

