package com.cryptopulse.app.telemetry

import android.content.Context
import com.cryptopulse.app.data.local.TokenManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Central, strictly fail-open Stage 9 Android observer.
 *
 * Design guarantees:
 * 1. Recording an event never blocks the calling thread or throws.
 * 2. When uninitialized (e.g. isolated unit tests without Android context), recording is a clean no-op
 *    unless a test sink / queue store is explicitly attached.
 * 3. Bounded disk queue (`<= 200` events) prevents unbounded storage growth offline.
 * 4. Batches are uploaded asynchronously to `/api/client/telemetry` via existing [OkHttpClient] + [TokenManager]
 *    with [TelemetryUploadJobService] (`JobScheduler`) fallback on offline/backoff states.
 */
object AndroidStage9Observer {

    private val stageSeq = AtomicLong(0L)
    private val consecutiveFailures = AtomicInteger(0)
    private val nextAllowedUploadAtMs = AtomicLong(0L)
    private val flushInFlight = AtomicBoolean(false)
    private val telemetryFailureRecorded = AtomicBoolean(false)
    private val recordedPopupAlertIds = java.util.Collections.synchronizedSet(java.util.LinkedHashSet<String>())

    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var queueStore: AndroidTelemetryQueueStore? = null

    @Volatile
    private var client: AndroidTelemetryClient? = null

    @Volatile
    internal var testEventListener: ((Stage9TelemetryEvent) -> Unit)? = null

    @Volatile
    internal var clockMs: () -> Long = { System.currentTimeMillis() }

    fun init(context: Context, okHttpClient: OkHttpClient, tokenManager: TokenManager) {
        try {
            val safeContext = context.applicationContext ?: context
            appContext = safeContext
            if (queueStore == null) {
                queueStore = AndroidTelemetryQueueStore(
                    queueFile = File(safeContext.filesDir, AndroidTelemetryQueueStore.QUEUE_FILENAME)
                )
            }
            if (client == null) {
                client = AndroidTelemetryClient(
                    okHttpClient = okHttpClient,
                    tokenProvider = { tokenManager.getToken() }
                )
            }
            // Attempt draining any leftovers from an earlier app session
            if ((queueStore?.size() ?: 0) > 0) {
                triggerAsyncFlush()
                TelemetryUploadJobService.schedule(safeContext, minLatencyMs = 2_000L)
            }
        } catch (_: Throwable) {
            // Strictly fail-open
        }
    }

    internal fun configureForTest(
        store: AndroidTelemetryQueueStore? = null,
        telemetryClient: AndroidTelemetryClient? = null,
        listener: ((Stage9TelemetryEvent) -> Unit)? = null
    ) {
        appContext = null
        queueStore = store
        client = telemetryClient
        testEventListener = listener
        stageSeq.set(0L)
        consecutiveFailures.set(0)
        nextAllowedUploadAtMs.set(0L)
        flushInFlight.set(false)
        telemetryFailureRecorded.set(false)
        recordedPopupAlertIds.clear()
        clockMs = { System.currentTimeMillis() }
    }

    internal fun resetForTest() {
        configureForTest(store = null, telemetryClient = null, listener = null)
    }

    fun pendingCount(): Int = try {
        queueStore?.size() ?: 0
    } catch (_: Throwable) {
        0
    }

    fun recordFcmReceived(
        fcmMessageId: String?,
        alertId: String?,
        symbol: String?,
        strategyId: String?,
        timeframe: String?,
        alertType: String?,
        hasDataPayload: Boolean
    ) {
        emit(
            Stage9TelemetryEvent(
                stageSeq = stageSeq.incrementAndGet(),
                eventType = Stage9TelemetryEvent.EventType.FCM_RECEIVED,
                status = if (hasDataPayload && !alertId.isNullOrBlank()) "PASS" else "WARN",
                severity = if (hasDataPayload) "INFO" else "WARNING",
                alertId = alertId,
                fcmMessageId = fcmMessageId,
                symbol = symbol,
                strategyId = strategyId,
                timeframe = timeframe,
                component = "FcmService.onMessageReceived",
                message = "FCM data payload received (type=${alertType ?: "UNKNOWN"}, alertId=${alertId ?: "none"})",
                outputSummary = mapOf(
                    "channel" to "FCM",
                    "alertType" to alertType,
                    "hasDataPayload" to hasDataPayload,
                    "fcmMessageId" to fcmMessageId
                )
            )
        )
    }

    fun recordPollReceived(
        alertId: String,
        symbol: String?,
        strategyId: String?,
        timeframe: String?
    ) {
        emit(
            Stage9TelemetryEvent(
                stageSeq = stageSeq.incrementAndGet(),
                eventType = Stage9TelemetryEvent.EventType.POLL_RECEIVED,
                status = "PASS",
                severity = "INFO",
                alertId = alertId,
                symbol = symbol,
                strategyId = strategyId,
                timeframe = timeframe,
                component = "BackgroundMonitoringService.pollBotAlerts",
                message = "Background polling picked up actionable alert $alertId for $symbol",
                outputSummary = mapOf(
                    "channel" to "POLL",
                    "source" to "BackgroundMonitoringService"
                )
            )
        )
    }

    fun recordDedupDecision(
        alertId: String?,
        symbol: String?,
        strategyId: String?,
        timeframe: String?,
        accepted: Boolean,
        reason: String,
        hardwareState: String? = null
    ) {
        emit(
            Stage9TelemetryEvent(
                stageSeq = stageSeq.incrementAndGet(),
                eventType = Stage9TelemetryEvent.EventType.DEDUP_DECISION,
                status = if (accepted) "PASS" else "SKIPPED",
                severity = "INFO",
                alertId = alertId,
                symbol = symbol,
                strategyId = strategyId,
                timeframe = timeframe,
                component = "TradeAlertManager.onNewAlertReceived",
                message = "Alert $alertId dedup decision: $reason",
                outputSummary = mapOf(
                    "decision" to if (accepted) Stage9TelemetryEvent.DedupDecision.ACCEPTED else Stage9TelemetryEvent.DedupDecision.SUPPRESSED,
                    "reason" to reason,
                    "hardwareState" to hardwareState
                )
            )
        )
    }

    fun recordNotificationPrecheck(
        alertId: String?,
        symbol: String?,
        strategyId: String?,
        timeframe: String?,
        notificationsEnabled: Boolean,
        channelEnabled: Boolean,
        channelImportance: Int
    ) {
        val headsUpEligible = notificationsEnabled && channelEnabled && channelImportance >= 3
        val osState = if (headsUpEligible) {
            Stage9TelemetryEvent.HeadsUpState.ELIGIBLE_OS_UNPROVABLE
        } else {
            Stage9TelemetryEvent.HeadsUpState.SUPPRESSED_PRECHECK
        }
        emit(
            Stage9TelemetryEvent(
                stageSeq = stageSeq.incrementAndGet(),
                eventType = Stage9TelemetryEvent.EventType.NOTIFICATION_PRECHECK,
                status = if (headsUpEligible) "PASS" else "WARN",
                severity = if (headsUpEligible) "INFO" else "WARNING",
                alertId = alertId,
                symbol = symbol,
                strategyId = strategyId,
                timeframe = timeframe,
                component = "TradeAlertManager.postSystemNotification",
                message = "Android notification precheck: state=$osState (enabled=$notificationsEnabled, channelEnabled=$channelEnabled, importance=$channelImportance)",
                outputSummary = mapOf(
                    "notificationsEnabled" to notificationsEnabled,
                    "channelEnabled" to channelEnabled,
                    "channelImportance" to channelImportance,
                    "headsUpEligible" to headsUpEligible,
                    "androidOsHeadsUpState" to osState
                )
            )
        )
    }

    fun recordNotificationPostCheck(
        alertId: String?,
        symbol: String?,
        strategyId: String?,
        timeframe: String?,
        notificationsEnabled: Boolean,
        channelImportance: Int,
        notifySucceeded: Boolean,
        activeNotificationFound: Boolean
    ) {
        val osState = when {
            !notificationsEnabled || channelImportance == 0 -> Stage9TelemetryEvent.HeadsUpState.SUPPRESSED_PRECHECK
            notifySucceeded && activeNotificationFound -> Stage9TelemetryEvent.HeadsUpState.ELIGIBLE_OS_UNPROVABLE
            else -> Stage9TelemetryEvent.HeadsUpState.POST_CHECK_MISSING
        }
        val postVerified = notifySucceeded && activeNotificationFound
        emit(
            Stage9TelemetryEvent(
                stageSeq = stageSeq.incrementAndGet(),
                eventType = Stage9TelemetryEvent.EventType.NOTIFICATION_POST_CHECK,
                status = if (osState == Stage9TelemetryEvent.HeadsUpState.ELIGIBLE_OS_UNPROVABLE) "PASS" else "WARN",
                severity = if (osState == Stage9TelemetryEvent.HeadsUpState.ELIGIBLE_OS_UNPROVABLE) "INFO" else "WARNING",
                alertId = alertId,
                symbol = symbol,
                strategyId = strategyId,
                timeframe = timeframe,
                component = "TradeAlertManager.postSystemNotification",
                message = "Android notification post-check: $osState (activeFound=$activeNotificationFound)",
                outputSummary = mapOf(
                    "notifySucceeded" to notifySucceeded,
                    "postNotifyVerified" to postVerified,
                    "activeNotificationFound" to activeNotificationFound,
                    "notificationsEnabled" to notificationsEnabled,
                    "channelImportance" to channelImportance,
                    "androidOsHeadsUpState" to osState
                )
            )
        )
    }

    fun recordAlertValidated(
        alertId: String?,
        symbol: String?,
        strategyId: String?,
        timeframe: String?,
        passed: Boolean,
        reason: String
    ) {
        emit(
            Stage9TelemetryEvent(
                stageSeq = stageSeq.incrementAndGet(),
                eventType = Stage9TelemetryEvent.EventType.ALERT_VALIDATED,
                status = if (passed) "PASS" else "FAIL",
                severity = if (passed) "INFO" else "WARNING",
                alertId = alertId,
                symbol = symbol,
                strategyId = strategyId,
                timeframe = timeframe,
                component = "MainActivity.validateAlertData",
                message = "MainActivity alert validation ${if (passed) "passed" else "rejected"} ($reason)",
                errorCode = if (passed) null else reason,
                outputSummary = mapOf(
                    "outcome" to if (passed) Stage9TelemetryEvent.ValidationOutcome.PASS else Stage9TelemetryEvent.ValidationOutcome.REJECTED,
                    "reason" to reason
                )
            )
        )
    }

    fun recordPopupRendered(
        alertId: String?,
        symbol: String?,
        strategyId: String?,
        timeframe: String?,
        entryPrice: Double,
        stopLossPrice: Double?,
        takeProfitPrice: Double?,
        isExecutable: Boolean?,
        quantity: Double?,
        requestedBudget: Double?,
        effectiveNotional: Double?
    ) {
        val normalizedAlertId = alertId?.trim()?.takeIf { it.isNotEmpty() } ?: return
        synchronized(recordedPopupAlertIds) {
            if (!recordedPopupAlertIds.add(normalizedAlertId)) {
                return
            }
            if (recordedPopupAlertIds.size > 256) {
                val oldest = recordedPopupAlertIds.iterator()
                if (oldest.hasNext()) {
                    oldest.next()
                    oldest.remove()
                }
            }
        }
        val renderedFields = buildMap<String, Any?> {
            symbol?.let { put("symbol", it) }
            strategyId?.let { put("strategyId", it) }
            timeframe?.let { put("timeframe", it) }
            put("entryPrice", entryPrice)
            stopLossPrice?.let { put("stopLossPrice", it) }
            takeProfitPrice?.let { put("takeProfitPrice", it) }
            isExecutable?.let { put("isExecutable", it) }
            quantity?.let { put("quantity", it) }
            requestedBudget?.let { put("requestedBudget", it) }
            effectiveNotional?.let { put("effectiveNotional", it) }
        }
        emit(
            Stage9TelemetryEvent(
                stageSeq = stageSeq.incrementAndGet(),
                eventType = Stage9TelemetryEvent.EventType.POPUP_RENDERED,
                status = "PASS",
                severity = "INFO",
                alertId = normalizedAlertId,
                symbol = symbol,
                strategyId = strategyId,
                timeframe = timeframe,
                component = "TradeAlertScreen",
                message = "Trade popup rendered for $symbol (${strategyId ?: "UNKNOWN"} / ${timeframe ?: "-"})",
                outputSummary = mapOf(
                    "rendered" to true,
                    "renderedFields" to renderedFields
                )
            )
        )
    }

    private fun emit(event: Stage9TelemetryEvent) {
        try {
            testEventListener?.invoke(event)
            val store = queueStore ?: return
            if (!store.enqueue(event)) return
            triggerAsyncFlush()
            appContext?.let { ctx ->
                TelemetryUploadJobService.schedule(ctx, minLatencyMs = 2_000L)
            }
        } catch (_: Throwable) {
            // Strictly fail-open
        }
    }

    private fun triggerAsyncFlush() {
        val store = queueStore ?: return
        val uploader = client ?: return
        if (clockMs() < nextAllowedUploadAtMs.get()) return
        if (!flushInFlight.compareAndSet(false, true)) return

        ioScope.launch {
            try {
                flushPendingInternal(store, uploader)
            } catch (_: Throwable) {
                // Fail-open
            } finally {
                flushInFlight.set(false)
            }
        }
    }

    suspend fun flushPendingSync(): Boolean {
        val store = queueStore ?: return true
        val uploader = client ?: return true
        if (!flushInFlight.compareAndSet(false, true)) return false
        return try {
            flushPendingInternal(store, uploader)
        } finally {
            flushInFlight.set(false)
        }
    }

    internal suspend fun flushPendingInternal(
        store: AndroidTelemetryQueueStore,
        uploader: AndroidTelemetryClient
    ): Boolean {
        var batchesUploaded = 0
        while (batchesUploaded < 10) {
            val now = clockMs()
            if (now < nextAllowedUploadAtMs.get()) {
                return false
            }
            val batch = store.peekBatch() ?: return true
            when (val outcome = uploader.uploadBatch(batch.payloadJson)) {
                is AndroidTelemetryClient.UploadOutcome.Sent -> {
                    store.dropHead(batch.count)
                    consecutiveFailures.set(0)
                    nextAllowedUploadAtMs.set(0L)
                    telemetryFailureRecorded.set(false)
                    batchesUploaded++
                }
                is AndroidTelemetryClient.UploadOutcome.DroppedInvalid -> {
                    // Prevent bad batch from blocking subsequent valid telemetry
                    store.dropHead(batch.count)
                    batchesUploaded++
                }
                is AndroidTelemetryClient.UploadOutcome.MissingAuth -> {
                    // Wait cleanly until user logs in; do not penalize as network failure
                    return false
                }
                is AndroidTelemetryClient.UploadOutcome.RateLimited -> {
                    nextAllowedUploadAtMs.set(now + outcome.retryAfterMs)
                    return false
                }
                is AndroidTelemetryClient.UploadOutcome.TransientFailure -> {
                    val failures = consecutiveFailures.incrementAndGet()
                    val backoffMs = (15_000L shl minOf(failures - 1, 6)).coerceAtMost(900_000L)
                    nextAllowedUploadAtMs.set(now + backoffMs)
                    if (failures >= 3 && telemetryFailureRecorded.compareAndSet(false, true)) {
                        store.enqueue(
                            Stage9TelemetryEvent(
                                stageSeq = stageSeq.incrementAndGet(),
                                tier = "TIER_2",
                                eventType = Stage9TelemetryEvent.EventType.TELEMETRY_FAILED,
                                status = "WARN",
                                severity = "WARNING",
                                component = "AndroidTelemetryClient",
                                message = "Stage 9 upload transiently failing (${outcome.reason}); backoff=${backoffMs}ms",
                                errorCode = outcome.httpCode?.let { "HTTP_$it" } ?: "NETWORK_ERROR",
                                errorMessage = outcome.reason,
                                outputSummary = mapOf(
                                    "consecutiveFailures" to failures,
                                    "backoffMs" to backoffMs,
                                    "queueSize" to store.size()
                                )
                            )
                        )
                    }
                    return false
                }
            }
        }
        return store.size() == 0
    }
}
