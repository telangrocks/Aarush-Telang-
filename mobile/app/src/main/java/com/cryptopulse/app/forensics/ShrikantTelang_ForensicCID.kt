package com.cryptopulse.app.forensics

import android.app.Application
import android.util.Log
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.bot.response.AnalysisSnapshotDto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * ShrikantTelang_ForensicCID
 *
 * Elite internal diagnostic and forensic investigation system operating inside
 * the CryptoPulse Android application for a 4-hour real-world live test.
 *
 * CRITICAL SAFETY REQUIREMENT:
 * This system is strictly OBSERVATION-ONLY.
 * It NEVER modifies trading logic, technical-analysis calculations, strategy parameters,
 * network calls, exchange orders, or error handling.
 */
object ShrikantTelang_ForensicCID {

    private const val TAG = "ForensicCID"

    private var application: Application? = null
    private var diskWriter: ForensicDiskWriter? = null
    private var crashHandler: ForensicCrashHandler? = null
    private var lifecycleObserver: ForensicLifecycleObserver? = null

    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private val cycleCounter = AtomicInteger(0)
    private val cycleDateFormat = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
    private val isoDateFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)

    private val summaryLock = Any()
    private lateinit var summary: ForensicSummary

    private var previousScore: Int? = null
    private val latestNetworkLatency = AtomicLong(0L)

    @Synchronized
    fun initialize(app: Application) {
        if (application != null) return
        application = app

        val now = System.currentTimeMillis()
        val isoStart = synchronized(isoDateFormat) { isoDateFormat.format(Date(now)) }

        summary = ForensicSummary(
            testStartTime = isoStart,
            lastUpdatedTime = isoStart
        )

        val writer = ForensicDiskWriter(app)
        writer.start()
        diskWriter = writer

        val ch = ForensicCrashHandler(writer) { fatalException ->
            synchronized(summaryLock) {
                summary.applicationCrashes++
                summary.totalErrors++
                summary.errorsByCategory["CRASH"] = (summary.errorsByCategory["CRASH"] ?: 0) + 1
                summary.lastUpdatedTime = synchronized(isoDateFormat) { isoDateFormat.format(Date()) }
                writer.updateSummary(summary)
            }
        }
        ch.install()
        crashHandler = ch

        val lo = ForensicLifecycleObserver(app) { eventType, details ->
            val eventNow = System.currentTimeMillis()
            val eventIso = synchronized(isoDateFormat) { isoDateFormat.format(Date(eventNow)) }
            val record = ForensicLifecycleRecord(
                timestamp = eventNow,
                isoTimestamp = eventIso,
                eventType = eventType,
                details = details
            )
            writer.enqueueRecord(record, priorityFlush = eventType == "APP_RESTART_UNCLEAN" || eventType == "APP_STOP")

            synchronized(summaryLock) {
                if (eventType == "APP_RESTART_UNCLEAN") {
                    summary.uncleanRestarts++
                    summary.totalErrors++
                    summary.errorsByCategory["UNEXPECTED_STATE"] = (summary.errorsByCategory["UNEXPECTED_STATE"] ?: 0) + 1
                }
                summary.lastUpdatedTime = eventIso
                writer.updateSummary(summary)
            }
        }
        lo.register()
        lifecycleObserver = lo

        Log.i(TAG, "=================================================================")
        Log.i(TAG, "[ShrikantTelang_ForensicCID] INITIALIZED SUCCESSFULLY.")
        Log.i(TAG, "[ShrikantTelang_ForensicCID] Log Destination: ${writer.getLogFilePath()}")
        Log.i(TAG, "[ShrikantTelang_ForensicCID] Mode: PASSIVE FORENSIC RECONSTRUCTION")
        Log.i(TAG, "=================================================================")
    }

    /**
     * Generates a unique, chronological Analysis Cycle ID:
     * e.g. CYCLE-20260907-084501-000123
     */
    fun generateCycleId(): String {
        val count = cycleCounter.incrementAndGet()
        val dateStr = synchronized(cycleDateFormat) { cycleDateFormat.format(Date()) }
        return String.format(Locale.US, "CYCLE-%s-%06d", dateStr, count)
    }

    /**
     * Passively records network metrics from ForensicNetworkInterceptor.
     */
    fun onNetworkObserved(
        endpoint: String,
        method: String,
        statusCode: Int,
        durationMs: Long,
        contentLength: Long,
        error: String?
    ) {
        latestNetworkLatency.set(durationMs)
        if (statusCode >= 400 || error != null) {
            val now = System.currentTimeMillis()
            val iso = synchronized(isoDateFormat) { isoDateFormat.format(Date(now)) }
            val networkRecord = ForensicLifecycleRecord(
                timestamp = now,
                isoTimestamp = iso,
                eventType = "NETWORK_ERROR",
                details = mapOf(
                    "endpoint" to endpoint,
                    "method" to method,
                    "status_code" to statusCode,
                    "duration_ms" to durationMs,
                    "content_length" to contentLength,
                    "error" to error
                )
            )
            diskWriter?.enqueueRecord(networkRecord, priorityFlush = true)

            synchronized(summaryLock) {
                summary.apiFailures++
                summary.totalErrors++
                summary.errorsByCategory["API_ERROR"] = (summary.errorsByCategory["API_ERROR"] ?: 0) + 1
                summary.lastUpdatedTime = iso
                diskWriter?.updateSummary(summary)
            }
        }
    }

    /**
     * Passive tap on the 3-second live bot polling loop in BotRepositoryImpl.
     */
    fun onAnalysisPollResult(
        result: NetworkResult<AnalysisSnapshotDto>,
        currentViewedStrategy: String? = null
    ) {
        scope.launch {
            try {
                processAnalysisResult("BOT_POLL", result, currentViewedStrategy)
                CidDiagnosticManager.onAnalysisPollResult(result, currentViewedStrategy)
            } catch (t: Throwable) {
                Log.e(TAG, "Error in onAnalysisPollResult: ${t.message}", t)
            }
        }
    }

    /**
     * Passive tap on the preview analysis polling in TechnicalAnalysisViewModel.
     */
    fun onPreviewAnalysisResult(
        result: NetworkResult<AnalysisSnapshotDto>,
        targetStrategy: String
    ) {
        scope.launch {
            try {
                processAnalysisResult("PREVIEW_POLL", result, targetStrategy)
            } catch (t: Throwable) {
                Log.e(TAG, "Error in onPreviewAnalysisResult: ${t.message}", t)
            }
        }
    }

    private fun processAnalysisResult(
        source: String,
        result: NetworkResult<AnalysisSnapshotDto>,
        viewedStrategy: String?
    ) {
        val startNs = System.nanoTime()
        val cycleId = generateCycleId()
        val netLatency = latestNetworkLatency.get()

        val snapshot: AnalysisSnapshotDto?
        val networkError: String?

        when (result) {
            is NetworkResult.Success -> {
                snapshot = result.data
                networkError = null
            }
            is NetworkResult.Error -> {
                snapshot = null
                networkError = when (val err = result.error) {
                    is com.cryptopulse.app.core.error.NetworkError.HttpError -> "HTTP ${err.code}: ${err.message}"
                    is com.cryptopulse.app.core.error.NetworkError.Timeout -> "Network Timeout"
                    is com.cryptopulse.app.core.error.NetworkError.Unauthorized -> "Unauthorized (Session Expired)"
                    is com.cryptopulse.app.core.error.NetworkError.Forbidden -> "Forbidden (Access Denied)"
                    is com.cryptopulse.app.core.error.NetworkError.NotFound -> "Not Found (404)"
                    is com.cryptopulse.app.core.error.NetworkError.Serialization -> "Serialization Error"
                    is com.cryptopulse.app.core.error.NetworkError.Unknown -> err.error.message ?: err.error.toString()
                    else -> err.toString()
                }
            }
        }

        val clientDurationMs = (System.nanoTime() - startNs) / 1_000_000

        val cycleRecord = ForensicSnapshotInspector.inspectCycle(
            cycleId = cycleId,
            source = source,
            snapshot = snapshot,
            networkDurationMs = netLatency,
            clientDurationMs = clientDurationMs,
            networkError = networkError,
            previousScore = previousScore,
            currentViewedStrategy = viewedStrategy
        )

        // Update previous score tracker
        if (cycleRecord.scoreForensics.finalScore > 0) {
            previousScore = cycleRecord.scoreForensics.finalScore
        }

        val priorityFlush = cycleRecord.signal.signalGenerated ||
                cycleRecord.pipelineGap.gapDetected ||
                cycleRecord.errors.isNotEmpty()

        diskWriter?.enqueueRecord(cycleRecord, priorityFlush = priorityFlush)

        updateSummaryWithCycle(cycleRecord)
    }

    private fun updateSummaryWithCycle(cycle: ForensicCycleRecord) {
        synchronized(summaryLock) {
            summary.totalAnalysisCycles++
            summary.lastUpdatedTime = cycle.isoTimestamp

            if (cycle.pipelineStatus == "COMPLETED") {
                summary.successfulCycles++
            } else {
                summary.failedCycles++
            }

            if (cycle.signal.signalGenerated) {
                summary.totalSignalsGenerated++
                when (cycle.signal.signalType?.uppercase()) {
                    "BUY" -> summary.buySignals++
                    "SELL" -> summary.sellSignals++
                }
            }

            if (cycle.qualification.qualificationResult == "FAILED") {
                summary.totalQualificationFailures++
                summary.totalRejectedSetups++
            }

            if (cycle.pipelineGap.gapDetected) {
                summary.totalPipelineGaps++
            }

            for (err in cycle.errors) {
                summary.totalErrors++
                val catName = err.category.name
                summary.errorsByCategory[catName] = (summary.errorsByCategory[catName] ?: 0) + 1
            }

            for (strat in cycle.strategies) {
                val sName = strat.strategyName
                summary.strategyExecutionCounts[sName] = (summary.strategyExecutionCounts[sName] ?: 0) + 1
                if (!strat.executionCompleted || strat.conditionsFailed.isNotEmpty()) {
                    summary.strategyFailures[sName] = (summary.strategyFailures[sName] ?: 0) + 1
                }
            }

            for (ind in cycle.indicators) {
                if (!ind.isValid || ind.status != "VALID") {
                    val iName = ind.indicatorName
                    summary.indicatorFailures[iName] = (summary.indicatorFailures[iName] ?: 0) + 1
                }
            }

            val cycleDuration = cycle.performance.totalCycleDurationMs ?: 0L
            if (cycleDuration > summary.longestAnalysisCycleMs) {
                summary.longestAnalysisCycleMs = cycleDuration
            }
            if (cycle.performance.performanceAnomaly) {
                summary.abnormalPerformanceEvents++
            }

            diskWriter?.updateSummary(summary)
        }
    }

    fun getLogFilePath(): String = diskWriter?.getLogFilePath() ?: "Not initialized"
    fun getSummaryFilePath(): String = diskWriter?.getSummaryFilePath() ?: "Not initialized"
    fun getLogFileSize(): Long = diskWriter?.getLogFileSize() ?: 0L
    fun getTotalCyclesRecorded(): Int = cycleCounter.get()
}
