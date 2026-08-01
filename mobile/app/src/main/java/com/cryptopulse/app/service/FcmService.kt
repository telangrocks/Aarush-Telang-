package com.cryptopulse.app.service

import android.util.Log
import com.cryptopulse.app.data.local.TokenManager
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class FcmService : FirebaseMessagingService() {

    @Inject
    lateinit var tokenManager: TokenManager

    @Inject
    lateinit var fcmRepository: com.cryptopulse.app.domain.repository.FcmRepository

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d("FcmService", "New FCM token generated: $token")

        serviceScope.launch {
            try {
                val jwtToken = tokenManager.getToken() ?: return@launch
                val response = fcmRepository.registerToken(token)
                if (response is com.cryptopulse.app.core.network.NetworkResult.Success) {
                    Log.d("FcmService", "FCM token registered with backend")
                } else {
                    Log.e("FcmService", "Failed to register FCM token")
                }
            } catch (e: Exception) {
                Log.e("FcmService", "Error registering FCM token", e)
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        
        Log.d("FcmService", "Message received from: ${message.from}")

        // Handle data payload
        if (message.data.isNotEmpty()) {
            Log.d("FcmService", "Message data payload: ${message.data}")
            handleDataPayload(message.data)
        }

        // Handle notification payload
        message.notification?.let {
            Log.d("FcmService", "Message Notification Body: ${it.body}")
            // System handles notification tray automatically when app is in background
        }
    }

    private fun handleDataPayload(data: Map<String, String>) {
        val alertType = data["type"]
        if (alertType == "TRADE_ALERT") {
            val alertData = mapOf<String, Any>(
                "id" to (data["id"] ?: ""),
                "symbol" to (data["symbol"] ?: ""),
                "entryPrice" to (data["entryPrice"]?.toDoubleOrNull() ?: 0.0),
                "stopLoss" to (data["stopLoss"]?.toDoubleOrNull() ?: 0.0),
                "takeProfit" to (data["takeProfit"]?.toDoubleOrNull() ?: 0.0),
                "estimatedPnl" to (data["estimatedPnl"]?.toDoubleOrNull() ?: 0.0),
                "strategy" to (data["strategy"] ?: ""),
                "side" to (data["side"] ?: "")
            )
            TradeAlertManager.getInstance(applicationContext).onNewAlertReceived(alertData)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // serviceScope.cancel() 
    }
}
