package com.cryptopulse.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.cryptopulse.R

class TradingBotService : Service() {

    private val CHANNEL_ID = "TradingBotServiceChannel"
    private val NOTIFICATION_ID = 1

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createNotificationChannel()
        val notification = createNotification("AI Trading Bot is active and monitoring the market...")
        startForeground(NOTIFICATION_ID, notification)

        // This is where you would maintain a connection or periodic check
        // For now, the service just runs to keep the app process alive

        return START_STICKY
    }

    private fun createNotification(text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CryptoPulse Bot")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_launcher_foreground) // Replace with a proper icon
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val serviceChannel = NotificationChannel(
                CHANNEL_ID,
                "Trading Bot Service Channel",
                NotificationManager.IMPORTANCE_DEFAULT
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(serviceChannel)
        }
    }

    override fun onBind(intent: Intent?): IBinder? {
        return null
    }
}