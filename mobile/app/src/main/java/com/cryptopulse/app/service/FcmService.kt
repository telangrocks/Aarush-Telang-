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

    @Inject
    lateinit var tradeAlertManager: TradeAlertManager

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
        val alertType = data["type"] ?: data["alertType"]
        if (alertType.equals("TRADE_ALERT", ignoreCase = true) || data["extra_alert"] == "true") {
            val alertId = data["id"] ?: data["alertId"] ?: data["opportunityId"] ?: ""
            if (alertId.isBlank()) return
            val alertData = buildMap<String, Any> {
                put("id", alertId)
                put("alertId", alertId)
                put("symbol", data["symbol"] ?: "")
                data["entryPrice"]?.toDoubleOrNull()?.let { put("entryPrice", it) }
                data["targetEntryPrice"]?.toDoubleOrNull()?.let { put("targetEntryPrice", it) }
                data["signalPrice"]?.toDoubleOrNull()?.let { put("signalPrice", it) }
                data["stopLoss"]?.toDoubleOrNull()?.let { put("stopLoss", it) }
                data["takeProfit"]?.toDoubleOrNull()?.let { put("takeProfit", it) }
                data["estimatedPnl"]?.toDoubleOrNull()?.let { put("estimatedPnl", it) }
                data["positionSize"]?.toDoubleOrNull()?.let { put("positionSize", it) }
                data["strategy"]?.let { put("strategy", it) }
                data["side"]?.let { put("side", it) }
                data["serverTimestamp"]?.let {
                    put("serverTimestamp", it)
                    put("timestamp", it)
                } ?: data["timestamp"]?.let {
                    put("serverTimestamp", it)
                    put("timestamp", it)
                }
                data["entryIntent"]?.let { put("entryIntent", it) }
                put("type", "TRADE_ALERT")
                put("alertType", "TRADE_ALERT")
            }
            tradeAlertManager.onNewAlertReceived(alertData)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // serviceScope.cancel() 
    }
}
