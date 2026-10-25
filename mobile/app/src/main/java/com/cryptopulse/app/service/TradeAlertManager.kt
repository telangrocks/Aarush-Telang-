package com.cryptopulse.app.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.cryptopulse.app.MainActivity
import com.cryptopulse.app.data.local.TradeAlertDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
open class TradeAlertManager @Inject constructor(
    @ApplicationContext private val appContext: Context,
    val dataStore: TradeAlertDataStore
) {
    constructor() : this(android.content.ContextWrapper(null), TradeAlertDataStore())
    constructor(dataStore: TradeAlertDataStore, dispatcher: kotlinx.coroutines.CoroutineDispatcher) : this(android.content.ContextWrapper(null), dataStore) {
        this.scope = CoroutineScope(dispatcher)
        restoreActiveAlert()
    }

    protected open val audioManager: TradeAlertAudioManager? by lazy {
        try { TradeAlertAudioManager(appContext) } catch (_: Throwable) { null }
    }
    protected open val vibrationManager: TradeAlertVibrationManager? by lazy {
        try { TradeAlertVibrationManager(appContext) } catch (_: Throwable) { null }
    }
    protected var scope: CoroutineScope = CoroutineScope(Dispatchers.IO)

    private val _currentState = MutableStateFlow(TradeAlertState.IDLE)
    val currentState: StateFlow<TradeAlertState> = _currentState

    private var activeAlertData: Map<String, Any>? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var hardwareTimeoutJob: Job? = null
    private var restoreJob: Job? = null
    @Volatile private var restoreFailed: Boolean = false
    private val restoreBarrier = kotlinx.coroutines.CompletableDeferred<Boolean>()
    private val handledAlertsCache = ConcurrentHashMap<String, String>()

    companion object {
        const val CHANNEL_ID = "trading_bot_channel"
        const val ALERT_NOTIFICATION_ID = 1002
        const val TRADE_ALERT_HARDWARE_TIMEOUT_MS = 30_000L // Central 30 seconds hardware lifetime
        const val WAKELOCK_TIMEOUT_MS = TRADE_ALERT_HARDWARE_TIMEOUT_MS + 5_000L // 35 seconds safety cap
    }

    init {
        try {
            createNotificationChannel()
            restoreActiveAlert()
        } catch (_: Throwable) {
            // Ignored during test environment with mock/wrapper context
        }
    }

    protected open fun restoreActiveAlert() {
        restoreJob?.cancel()
        restoreJob = scope.launch {
            try {
                val history = dataStore.getHandledAlertHistory()
                history.forEach { (id, record) ->
                    handledAlertsCache[id] = record.hardwareState
                }
                val alert = dataStore.getActiveAlertFlow().first()
                if (alert != null) {
                    activeAlertData = alert
                    _currentState.value = TradeAlertState.USER_VIEWING_ALERT
                    TradeAlertLogger.log("ALERT_RESTORED", "Restored active alert from DataStore: ${alert["id"]}")
                }
                restoreFailed = false
                restoreBarrier.complete(true)
            } catch (e: Throwable) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                TradeAlertLogger.error("ALERT_RESTORE_FAILED", e)
                restoreFailed = true
                restoreBarrier.complete(false)
            }
        }
    }

    @Synchronized
    open fun onNewAlertReceived(alertData: Map<String, Any>) {
        val alertId = (alertData["id"] as? String) ?: (alertData["alertId"] as? String) ?: return
        var existingHardwareState = handledAlertsCache[alertId]
        if (existingHardwareState == null) {
            val persistedRecord = try {
                kotlinx.coroutines.runBlocking { dataStore.getHandledAlertHistory()[alertId] }
            } catch (_: Throwable) { null }
            if (persistedRecord != null) {
                existingHardwareState = persistedRecord.hardwareState
                handledAlertsCache[alertId] = persistedRecord.hardwareState
            }
        }

        if (existingHardwareState == "RESOLVED") {
            TradeAlertLogger.log(
                "RESOLVED_ALERT_SUPPRESSED",
                "Alert $alertId is already resolved; ignoring duplicate presentation."
            )
            return
        }

        val status = alertData["status"] as? String
        if (status == "expired" || status == "executed" || status == "filled") {
            TradeAlertLogger.log(
                "TERMINAL_ALERT_SUPPRESSED",
                "Alert $alertId is in terminal status $status; ignoring."
            )
            return
        }

        if (existingHardwareState != null) {
            TradeAlertLogger.log(
                "DUPLICATE_ALERT_HARDWARE_SUPPRESSED",
                "Alert $alertId is already in state $existingHardwareState; suppressing duplicate hardware trigger."
            )
            // Decouple hardware silencing from UI delivery:
            // An unresolved alert must still update active alert data and reach the UI via AlertBus
            activeAlertData = alertData
            scope.launch { dataStore?.saveActiveAlert(alertData) }
            scope.launch { AlertBus.send(alertData) }
            return
        }

        val symbol = alertData["symbol"] as? String ?: "UNKNOWN"
        val entryPrice = (alertData["entryPrice"] as? Double) ?: 0.0
        val stopLoss = (alertData["stopLoss"] as? Double) ?: (alertData["stop_loss"] as? Double)
        val takeProfit = (alertData["takeProfit"] as? Double) ?: (alertData["take_profit"] as? Double)
        val strategyId = (alertData["strategy"] as? String) ?: (alertData["strategyId"] as? String)
        val signalType = (alertData["signalType"] as? String) ?: (alertData["direction"] as? String) ?: (alertData["type"] as? String)

        TradeAlertLogger.log("ALERT_RECEIVED", "Symbol: $symbol, Entry: $entryPrice, AlertId: $alertId")
        try {
            com.cryptopulse.app.forensics.CidDiagnosticManager.logAlertReceived(
                alertId = alertId,
                symbol = symbol,
                strategyId = strategyId,
                signalType = signalType,
                entryPrice = entryPrice,
                stopLoss = stopLoss,
                takeProfit = takeProfit
            )
        } catch (_: Throwable) {}

        // Mark as active in idempotency history
        handledAlertsCache[alertId] = "HARDWARE_ACTIVE"
        scope.launch {
            try {
                dataStore?.recordAlertHardwareState(alertId, "HARDWARE_ACTIVE")
            } catch (_: Throwable) {}
        }

        if (_currentState.value == TradeAlertState.VOICE_PLAYING && activeAlertData != null) {
            // Seamless Replace Strategy: Update active data & UI, keep voice/vibration playing uninterrupted
            activeAlertData = alertData
            scope.launch { dataStore?.saveActiveAlert(alertData) }
            _currentState.value = TradeAlertState.ALERT_REPLACED
            TradeAlertLogger.log("ALERT_REPLACED", "Updated active alert details to latest signal ($symbol)")
            acquireWakeLock()
            scope.launch { postSystemNotification(alertData) }
            _currentState.value = TradeAlertState.VOICE_PLAYING
            scope.launch { AlertBus.send(alertData) }

            // Reset hardware watchdog specifically for the replacing alert
            hardwareTimeoutJob?.cancel()
            hardwareTimeoutJob = scope.launch {
                delay(TRADE_ALERT_HARDWARE_TIMEOUT_MS)
                val currentActiveId = (activeAlertData?.get("id") as? String) ?: (activeAlertData?.get("alertId") as? String)
                if (currentActiveId == alertId) {
                    TradeAlertLogger.log("HARDWARE_TIMEOUT_EXPIRED", "30-second hardware timeout reached for replacing alert $alertId. Silencing hardware.")
                    silenceHardware(alertId)
                }
            }
            return
        }

        // Fresh alert trigger (from IDLE, HARDWARE_SILENCED, USER_VIEWING_ALERT, etc.)
        activeAlertData = alertData
        scope.launch { dataStore?.saveActiveAlert(alertData) }
        _currentState.value = TradeAlertState.ALERT_TRIGGERED

        acquireWakeLock()
        audioManager?.startAlert()
        vibrationManager?.startVibration()
        scope.launch { postSystemNotification(alertData) }

        _currentState.value = TradeAlertState.VOICE_PLAYING
        scope.launch { AlertBus.send(alertData) }

        // Start authoritative central hardware lifetime watchdog
        hardwareTimeoutJob?.cancel()
        hardwareTimeoutJob = scope.launch {
            delay(TRADE_ALERT_HARDWARE_TIMEOUT_MS)
            val currentActiveId = (activeAlertData?.get("id") as? String) ?: (activeAlertData?.get("alertId") as? String)
            if (currentActiveId == alertId) {
                TradeAlertLogger.log("HARDWARE_TIMEOUT_EXPIRED", "30-second hardware timeout reached for $alertId. Silencing hardware.")
                silenceHardware(alertId)
            }
        }
    }

    /**
     * Authoritative central operation to silence alert hardware (audio, vibration, WakeLock, watchdog).
     * Strictly PRESERVES active alert data, DataStore state, and trade opportunity.
     * Completely idempotent and safe to call repeatedly.
     */
    @Synchronized
    open fun silenceHardware(alertId: String? = null) {
        hardwareTimeoutJob?.cancel()
        hardwareTimeoutJob = null

        audioManager?.stopAlert()
        vibrationManager?.stopVibration()
        releaseWakeLock()

        val targetId = alertId ?: (activeAlertData?.get("id") as? String) ?: (activeAlertData?.get("alertId") as? String)
        if (targetId != null) {
            if (handledAlertsCache[targetId] != "RESOLVED") {
                handledAlertsCache[targetId] = "HARDWARE_SILENCED"
                scope.launch {
                    try {
                        dataStore?.recordAlertHardwareState(targetId, "HARDWARE_SILENCED")
                    } catch (_: Throwable) {}
                }
            }
        }

        if (_currentState.value == TradeAlertState.VOICE_PLAYING || _currentState.value == TradeAlertState.ALERT_TRIGGERED) {
            _currentState.value = TradeAlertState.HARDWARE_SILENCED
        }
        TradeAlertLogger.log("HARDWARE_SILENCED", "Hardware silenced. Alert data and trade opportunity preserved.")
    }

    /**
     * Restores an active or pending alert for viewing in the UI without re-arming hardware alarms.
     * Used by cold-start restoration and notification intent routing.
     */
    @Synchronized
    open fun restoreAlertForViewing(alertData: Map<String, Any>) {
        val alertId = (alertData["id"] as? String) ?: (alertData["alertId"] as? String) ?: return
        activeAlertData = alertData
        if (handledAlertsCache[alertId] != "RESOLVED" && !handledAlertsCache.containsKey(alertId)) {
            handledAlertsCache[alertId] = "HARDWARE_SILENCED"
            scope.launch {
                try {
                    dataStore?.recordAlertHardwareState(alertId, "HARDWARE_SILENCED")
                } catch (_: Throwable) {}
            }
        }
        scope.launch {
            try {
                dataStore?.saveActiveAlert(alertData)
            } catch (_: Throwable) {}
        }
        if (_currentState.value == TradeAlertState.IDLE || _currentState.value == TradeAlertState.VOICE_PLAYING) {
            _currentState.value = TradeAlertState.USER_VIEWING_ALERT
        }
        scope.launch { AlertBus.send(alertData) }
        TradeAlertLogger.log("ALERT_RESTORED_FOR_VIEWING", "Alert $alertId restored for viewing without hardware re-arm.")
    }

    open fun onUserViewingAlertScreen() {
        if (_currentState.value == TradeAlertState.VOICE_PLAYING || _currentState.value == TradeAlertState.HARDWARE_SILENCED) {
            _currentState.value = TradeAlertState.USER_VIEWING_ALERT
            TradeAlertLogger.log("USER_VIEWING_ALERT", "User presented with Trade Alert UI")
            try {
                com.cryptopulse.app.forensics.CidDiagnosticManager.logLifecycle(
                    component = "TradeAlertManager",
                    eventName = "USER_VIEWING_ALERT",
                    payload = com.cryptopulse.app.forensics.CidLifecyclePayload(
                        eventType = "USER_VIEWING_ALERT",
                        reason = "User presented with Trade Alert UI"
                    )
                )
            } catch (_: Throwable) {}
        }
    }

    @Synchronized
    open fun dismissOrExecuteAlert() {
        if (_currentState.value == TradeAlertState.IDLE) return
        _currentState.value = TradeAlertState.STOPPING
        TradeAlertLogger.log("USER_ACTION_STOP", "User executed or cancelled trade. Stopping alert engine.")

        val targetId = (activeAlertData?.get("id") as? String) ?: (activeAlertData?.get("alertId") as? String)
        if (targetId != null) {
            handledAlertsCache[targetId] = "RESOLVED"
            scope.launch {
                try {
                    dataStore?.recordAlertHardwareState(targetId, "RESOLVED")
                } catch (_: Throwable) {}
            }
        }

        silenceHardware(targetId)
        cancelSystemNotification()

        activeAlertData = null
        scope.launch { dataStore?.saveActiveAlert(null) }
        _currentState.value = TradeAlertState.IDLE
    }

    /**
     * Invoked ONLY when BackgroundMonitoringService is destroyed by the Android OS.
     * Stops audio and vibration effects to prevent runaway loops, but strictly
     * PRESERVES the system notification and persistent DataStore alert.
     */
    fun stopAudioAndVibrationOnServiceTeardown() {
        silenceHardware()
    }

    /**
     * Invoked during cold-start recovery when a persisted alert is verified to be expired or executed.
     * Purges local active and DataStore alert state without representing a user cancellation.
     */
    fun clearStaleStartupAlert() {
        silenceHardware()
        cancelSystemNotification()
        activeAlertData = null
        scope.launch { dataStore?.saveActiveAlert(null) }
        _currentState.value = TradeAlertState.IDLE
    }

    fun getActiveAlert(): Map<String, Any>? = activeAlertData

    /**
     * Explicit non-blocking synchronization barrier.
     * Suspends until DataStore restoration completes.
     * Cannot return early because restoreBarrier is initialized at object instantiation.
     * Returns true if restoration succeeded, false if DataStore read failed.
     */
    open suspend fun awaitRestored(): Boolean {
        return restoreBarrier.await()
    }

    /**
     * Non-blocking O(1) memory lookup safe for Android Main Thread invocation.
     * Returns true ONLY if the alert has been explicitly resolved (executed or dismissed).
     * If DataStore restoration failed and the alert is unverified in memory, returns true (fail-closed)
     * so that an empty cache after a failed read does not authorize duplicate execution.
     */
    open fun isAlertResolved(alertId: String): Boolean {
        val cachedState = handledAlertsCache[alertId]
        if (cachedState != null) {
            return cachedState == "RESOLVED"
        }
        if (restoreFailed) {
            TradeAlertLogger.log(
                "ALERT_RESTORE_FAIL_CLOSED",
                "Alert $alertId is unverified because DataStore restoration failed. Rejecting duplicate."
            )
            return true
        }
        return false
    }

    /**
     * Checks if the alert was previously received in this or a restored session.
     * Used for hardware suppression to prevent re-arming sound/vibration.
     */
    open fun isAlertKnown(alertId: String): Boolean {
        if (handledAlertsCache.containsKey(alertId)) return true
        val fromDataStore = try {
            kotlinx.coroutines.runBlocking { dataStore.getHandledAlertHistory()[alertId] }
        } catch (_: Throwable) { null }
        if (fromDataStore != null) {
            handledAlertsCache[alertId] = fromDataStore.hardwareState
            return true
        }
        return false
    }

    open fun isAlertHandled(alertId: String): Boolean = isAlertResolved(alertId)

    private fun acquireWakeLock() {
        if (appContext == null) return
        try {
            if (wakeLock?.isHeld == true) return
            val powerManager = appContext.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "CryptoPulse:TradeAlertWakeLock"
            ).apply {
                acquire(WAKELOCK_TIMEOUT_MS)
            }
            TradeAlertLogger.log("WAKELOCK_ACQUIRED", "Partial WakeLock held with bounded safety cap ($WAKELOCK_TIMEOUT_MS ms)")
        } catch (e: Exception) {
            TradeAlertLogger.error("WAKELOCK_ACQUIRE_ERROR", e)
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
                TradeAlertLogger.log("WAKELOCK_RELEASED", "Partial WakeLock released")
            }
        } catch (e: Exception) {
            TradeAlertLogger.error("WAKELOCK_RELEASE_ERROR", e)
        } finally {
            wakeLock = null
        }
    }

    private fun createNotificationChannel() {
        if (appContext == null) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Trading Bot Monitor",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "High priority trade alert notifications with voice and vibration"
                enableVibration(true)
            }
            val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            manager?.createNotificationChannel(channel)
        }
    }

    private fun postSystemNotification(alertData: Map<String, Any>) {
        if (appContext == null) return
        try {
            val symbol = alertData["symbol"] as? String ?: "UNKNOWN"
            val side = alertData["side"] as? String ?: "BUY"
            val entryPrice = (alertData["entryPrice"] as? Double) ?: 0.0
            val stopLoss = (alertData["stopLoss"] as? Double) ?: 0.0
            val takeProfit = (alertData["takeProfit"] as? Double) ?: 0.0
            val estimatedPnl = (alertData["estimatedPnl"] as? Double) ?: 0.0
            val alertId = (alertData["id"] as? String) ?: (alertData["alertId"] as? String) ?: ""

            val strategy = (alertData["strategy"] as? String) ?: (alertData["strategyId"] as? String) ?: "ScalperV2"
            val timeframe = alertData["timeframe"] as? String
            val positionSize = (alertData["positionSize"] as? Double) ?: 0.0
            val timestamp = (alertData["serverTimestamp"] as? String)?.toLongOrNull()
                ?: (alertData["timestamp"] as? String)?.toLongOrNull()
                ?: System.currentTimeMillis()

            val intent = Intent(appContext, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("extra_alert", true)
                putExtra("alert_symbol", symbol)
                putExtra("symbol", symbol)
                putExtra("side", side)
                putExtra("alert_side", side)
                putExtra("strategy", strategy)
                putExtra("alert_strategy", strategy)
                timeframe?.let {
                    putExtra("timeframe", it)
                    putExtra("alert_timeframe", it)
                }
                putExtra("alert_entry_price", entryPrice)
                putExtra("entryPrice", entryPrice.toString())
                putExtra("alert_stop_loss", stopLoss)
                putExtra("stopLoss", stopLoss.toString())
                putExtra("alert_take_profit", takeProfit)
                putExtra("takeProfit", takeProfit.toString())
                putExtra("alert_estimated_pnl", estimatedPnl)
                putExtra("estimatedPnl", estimatedPnl.toString())
                putExtra("alert_position_size", positionSize)
                putExtra("positionSize", positionSize.toString())
                putExtra("alert_id", alertId)
                putExtra("id", alertId)
                putExtra("serverTimestamp", timestamp.toString())
                putExtra("alert_timestamp", timestamp)
            }

            val pendingIntent = PendingIntent.getActivity(
                appContext, 2, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val silenceIntent = Intent(appContext, TradeAlertActionReceiver::class.java).apply {
                action = TradeAlertActionReceiver.ACTION_SILENCE
                putExtra(TradeAlertActionReceiver.EXTRA_ALERT_ID, alertId)
            }
            val silencePendingIntent = PendingIntent.getBroadcast(
                appContext, 101, silenceIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val deleteIntent = Intent(appContext, TradeAlertActionReceiver::class.java).apply {
                action = TradeAlertActionReceiver.ACTION_DISMISS
                putExtra(TradeAlertActionReceiver.EXTRA_ALERT_ID, alertId)
            }
            val deletePendingIntent = PendingIntent.getBroadcast(
                appContext, 102, deleteIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val notification = NotificationCompat.Builder(appContext, CHANNEL_ID)
                .setContentTitle("🚨 Attention! Trade Detected")
                .setContentText("$side $symbol | Entry: $${"%.2f".format(entryPrice)}")
                .setSmallIcon(com.cryptopulse.app.R.drawable.ic_notification_cryptopulse)
                .setContentIntent(pendingIntent)
                .addAction(
                    android.R.drawable.ic_lock_silent_mode_off,
                    "SILENCE",
                    silencePendingIntent
                )
                .setDeleteIntent(deletePendingIntent)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .build()

            val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            manager?.notify(ALERT_NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            TradeAlertLogger.error("NOTIFICATION_NOTIFY_ERROR", e)
        }
    }

    private fun cancelSystemNotification() {
        if (appContext == null) return
        try {
            val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.cancel(ALERT_NOTIFICATION_ID)
        } catch (e: Exception) {
            TradeAlertLogger.error("NOTIFICATION_CANCEL_ERROR", e)
        }
    }
}
