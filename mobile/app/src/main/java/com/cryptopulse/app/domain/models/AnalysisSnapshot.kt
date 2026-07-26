package com.cryptopulse.app.domain.models

data class TimeframeStatusData(
    val interval: String,
    val isLoaded: Boolean,
    val candleCount: Int
)

data class MacdData(
    val macd: Double,
    val signal: Double,
    val histogram: Double
)

data class IndicatorSnapshotData(
    val rsi: Double,
    val macd: MacdData,
    val ema20: Double,
    val ema50: Double,
    val sma200: Double,
    val atr: Double
)

data class CheckpointItemData(
    val id: String,
    val name: String,
    val description: String,
    val isMet: Boolean,
    val value: String,
    val target: String
)

data class DecisionPipelineData(
    val confluenceScore: Double,
    val alignment: String, // "LONG", "SHORT", "NONE"
    val primarySignal: String // "BUY", "SELL", "HOLD"
)

data class RuntimeMetricsData(
    val cycleNumber: Int,
    val uptimeSeconds: Long,
    val lastCompletedCycleMs: Long,
    val analysisDurationMs: Long,
    val exchangeLatencyMs: Long,
    val lastSuccessfulUpdate: String
)

data class EngineHealthData(
    val status: String, // "HEALTHY", "DEGRADED", "CRITICAL"
    val activeSubscriptionsCount: Int,
    val errorsCount: Int
)

data class ConnectionHealthData(
    val transportType: String, // "POLLING", "WEBSOCKET", "SSE"
    val isConnected: Boolean,
    val reconnectCount: Int
)

data class AnalysisSnapshot(
    val schemaVersion: String = "2.0",
    val sessionId: String,
    val botState: BotState,
    val symbol: String,
    val exchange: String,
    val strategy: String,
    val timeframeStatus: Map<String, TimeframeStatusData> = emptyMap(),
    val indicators: IndicatorSnapshotData,
    val checkpoints: List<CheckpointItemData> = emptyList(),
    val confidence: Int,
    val decisionPipeline: DecisionPipelineData,
    val runtimeMetrics: RuntimeMetricsData,
    val engineHealth: EngineHealthData,
    val connectionHealth: ConnectionHealthData,
    val timestamp: String
)
