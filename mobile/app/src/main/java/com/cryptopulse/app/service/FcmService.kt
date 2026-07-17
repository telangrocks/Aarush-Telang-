package com.cryptopulse.app.service

import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class FcmService : FirebaseMessagingService() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Inject
    lateinit var tokenManager: com.cryptopulse.app.data.local.TokenManager

    @Inject
    lateinit var fcmApi: com.cryptopulse.app.data.api.FcmApi

    override fun onNewToken(token: String) {
        Log.d("FcmService", "New FCM token: $token")
        registerTokenWithBackend(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Log.d("FcmService", "Message received from: ${message.from}")

        message.data.let { data ->
            Log.d("FcmService", "Message data: $data")
            if (data["type"] == "trade_alert") {
                val alert = mapOf(
                    "id" to (data["alertId"] ?: data["id"] ?: ""),
                    "symbol" to (data["symbol"] ?: "UNKNOWN"),
                    "entryPrice" to (data["entryPrice"]?.toDoubleOrNull() ?: 0.0),
                    "stopLoss" to (data["stopLoss"]?.toDoubleOrNull() ?: 0.0),
                    "takeProfit" to (data["takeProfit"]?.toDoubleOrNull() ?: 0.0),
                    "estimatedPnl" to (data["estimatedPnl"]?.toDoubleOrNull() ?: 0.0),
                )
                // Surface the alert immediately if the app is in the foreground.
                serviceScope.launch { AlertBus.send(alert) }
            }
        }

        message.notification?.let { notification ->
            Log.d("FcmService", "Notification Title: ${notification.title}")
            Log.d("FcmService", "Notification Body: ${notification.body}")
        }
    }

    private fun registerTokenWithBackend(token: String) {
        serviceScope.launch {
            try {
                val jwtToken = tokenManager.getToken() ?: return@launch
                val request = mapOf("fcmToken" to token)
                val response = fcmApi.registerToken(request)
                if (response.isSuccessful) {
                    Log.d("FcmService", "FCM token registered with backend")
                } else {
                    Log.e("FcmService", "Failed to register FCM token: ${response.code()}")
                }
            } catch (e: Exception) {
                Log.e("FcmService", "Error registering FCM token", e)
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
    }
}
