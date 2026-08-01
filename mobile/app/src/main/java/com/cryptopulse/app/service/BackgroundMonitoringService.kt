package com.cryptopulse.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.cryptopulse.app.MainActivity
import com.cryptopulse.app.data.local.TokenManager
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.*
import javax.inject.Inject

@AndroidEntryPoint
class BackgroundMonitoringService : Service() {
    @Inject
    lateinit var tokenManager: TokenManager

    @Inject
    lateinit var botRepository: com.cryptopulse.app.domain.repository.BotRepository

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pollingJob: Job? = null
    private var lastAlertId: String? = null

    companion object {
        const val CHANNEL_ID = "trading_bot_channel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_STOP_SERVICE = "stop_service"

        fun startService(context: Context) {
            val intent = Intent(context, BackgroundMonitoringService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopService(context: Context) {
            val intent = Intent(context, BackgroundMonitoringService::class.java)
            context.stopService(intent)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP_SERVICE) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification("Monitoring market..."))

        pollingJob?.cancel()
        pollingJob = serviceScope.launch {
            while (isActive) {
                try {
                    pollForAlerts()
                } catch (e: Exception) {
                    Log.e("BackgroundMonitoring", "Polling error", e)
                }
                delay(30_000)
            }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        TradeAlertManager.getInstance(applicationContext).dismissOrExecuteAlert()
        pollingJob?.cancel()
        serviceScope.cancel()
    }

    override fun onBind(intent: Intent): IBinder? {
        return null
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Trading Bot Monitor",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Shows when trading bot detects an opportunity"
                enableVibration(true)
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(content: String): Notification {
        val activityIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val activityPendingIntent = PendingIntent.getActivity(
            this, 0, activityIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val stopIntent = Intent(this, BackgroundMonitoringService::class.java).apply {
            action = ACTION_STOP_SERVICE
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CryptoPulse Bot Active")
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(activityPendingIntent)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
    }

    private suspend fun pollForAlerts() {
        val token = tokenManager.getToken() ?: run {
            stopSelf()
            return
        }

        withContext(Dispatchers.IO) {
            try {
                val result = botRepository.getAlerts()
                if (result is com.cryptopulse.app.core.network.NetworkResult.Error && result.error is com.cryptopulse.app.core.error.NetworkError.Unauthorized) {
                    stopSelf()
                    return@withContext
                }
                if (result is com.cryptopulse.app.core.network.NetworkResult.Success) {
                    val alerts = result.data
                    if (alerts.isNotEmpty()) {
                        val latestAlert = alerts.first()
                        if (latestAlert.id != lastAlertId) {
                            lastAlertId = latestAlert.id
                            showTradeAlert(latestAlert)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("BackgroundMonitoring", "Failed to poll alerts", e)
            }
        }
    }

    private fun showTradeAlert(alert: com.cryptopulse.app.domain.models.BotAlert) {
        val map = mapOf<String, Any>(
            "id" to alert.id,
            "symbol" to alert.symbol,
            "entryPrice" to alert.entryPrice,
            "stopLoss" to alert.stopLoss,
            "takeProfit" to alert.takeProfit,
            "estimatedPnl" to alert.estimatedPnl,
            "strategy" to (alert.strategy ?: ""),
            "side" to (alert.side ?: "")
        )
        TradeAlertManager.getInstance(applicationContext).onNewAlertReceived(map)
    }
}
