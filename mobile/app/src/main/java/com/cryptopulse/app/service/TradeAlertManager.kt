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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class TradeAlertManager private constructor(context: Context) {

    private val appContext = context.applicationContext
    private val audioManager = TradeAlertAudioManager(appContext)
    private val vibrationManager = TradeAlertVibrationManager(appContext)
    private val scope = CoroutineScope(Dispatchers.IO)

    private val _currentState = MutableStateFlow(TradeAlertState.IDLE)
    val currentState: StateFlow<TradeAlertState> = _currentState

    private var activeAlertData: Map<String, Any>? = null
    private var wakeLock: PowerManager.WakeLock? = null

    companion object {
        const val CHANNEL_ID = "trading_bot_channel"
        const val ALERT_NOTIFICATION_ID = 1002
        private const val WAKELOCK_TIMEOUT_MS = 5 * 60 * 1000L // 5 minutes safety timeout

        @Volatile
        private var instance: TradeAlertManager? = null

        fun getInstance(context: Context): TradeAlertManager {
            return instance ?: synchronized(this) {
                instance ?: TradeAlertManager(context).also { instance = it }
            }
        }
    }

    init {
        createNotificationChannel()
    }

    @Synchronized
    fun onNewAlertReceived(alertData: Map<String, Any>) {
        val alertId = alertData["id"] as? String ?: return
        val symbol = alertData["symbol"] as? String ?: "UNKNOWN"
        val entryPrice = (alertData["entryPrice"] as? Double) ?: 0.0

        TradeAlertLogger.log("ALERT_RECEIVED", "Symbol: $symbol, Entry: $entryPrice, AlertId: $alertId")

        if (_currentState.value != TradeAlertState.IDLE && activeAlertData != null) {
            // Seamless Replace Strategy: Update active data & UI, keep voice/vibration playing uninterrupted
            activeAlertData = alertData
            _currentState.value = TradeAlertState.ALERT_REPLACED
            TradeAlertLogger.log("ALERT_REPLACED", "Updated active alert details to latest signal ($symbol)")
            scope.launch { AlertBus.send(alertData) }
            postSystemNotification(alertData)
            _currentState.value = TradeAlertState.VOICE_PLAYING
            return
        }

        // Fresh alert trigger
        activeAlertData = alertData
        _currentState.value = TradeAlertState.ALERT_TRIGGERED

        acquireWakeLock()
        audioManager.startAlert()
        vibrationManager.startVibration()
        postSystemNotification(alertData)

        _currentState.value = TradeAlertState.VOICE_PLAYING
        scope.launch { AlertBus.send(alertData) }
    }

    fun onUserViewingAlertScreen() {
        if (_currentState.value == TradeAlertState.VOICE_PLAYING) {
            _currentState.value = TradeAlertState.USER_VIEWING_ALERT
            TradeAlertLogger.log("USER_VIEWING_ALERT", "User presented with Trade Alert UI")
        }
    }

    @Synchronized
    fun dismissOrExecuteAlert() {
        if (_currentState.value == TradeAlertState.IDLE) return
        _currentState.value = TradeAlertState.STOPPING
        TradeAlertLogger.log("USER_ACTION_STOP", "User executed or cancelled trade. Stopping alert engine.")

        audioManager.stopAlert()
        vibrationManager.stopVibration()
        releaseWakeLock()
        cancelSystemNotification()

        activeAlertData = null
        _currentState.value = TradeAlertState.IDLE
    }

    fun getActiveAlert(): Map<String, Any>? = activeAlertData

    private fun acquireWakeLock() {
        try {
            if (wakeLock?.isHeld == true) return
            val powerManager = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "CryptoPulse:TradeAlertWakeLock"
            ).apply {
                acquire(WAKELOCK_TIMEOUT_MS)
            }
            TradeAlertLogger.log("WAKELOCK_ACQUIRED", "Partial WakeLock held with 5-minute safety cap")
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Trading Bot Monitor",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "High priority trade alert notifications with voice and vibration"
                enableVibration(true)
            }
            val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun postSystemNotification(alertData: Map<String, Any>) {
        val symbol = alertData["symbol"] as? String ?: "UNKNOWN"
        val side = alertData["side"] as? String ?: "BUY"
        val entryPrice = (alertData["entryPrice"] as? Double) ?: 0.0
        val stopLoss = (alertData["stopLoss"] as? Double) ?: 0.0
        val takeProfit = (alertData["takeProfit"] as? Double) ?: 0.0
        val estimatedPnl = (alertData["estimatedPnl"] as? Double) ?: 0.0
        val alertId = alertData["id"] as? String

        val intent = Intent(appContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("extra_alert", true)
            putExtra("alert_symbol", symbol)
            putExtra("alert_entry_price", entryPrice)
            putExtra("alert_stop_loss", stopLoss)
            putExtra("alert_take_profit", takeProfit)
            putExtra("alert_estimated_pnl", estimatedPnl)
            putExtra("alert_id", alertId)
        }

        val pendingIntent = PendingIntent.getActivity(
            appContext, 2, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(appContext, CHANNEL_ID)
            .setContentTitle("🚨 Attention! Trade Detected")
            .setContentText("$side $symbol | Entry: $${"%.2f".format(entryPrice)}")
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .build()

        val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(ALERT_NOTIFICATION_ID, notification)
    }

    private fun cancelSystemNotification() {
        try {
            val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.cancel(ALERT_NOTIFICATION_ID)
        } catch (e: Exception) {
            TradeAlertLogger.error("NOTIFICATION_CANCEL_ERROR", e)
        }
    }
}
