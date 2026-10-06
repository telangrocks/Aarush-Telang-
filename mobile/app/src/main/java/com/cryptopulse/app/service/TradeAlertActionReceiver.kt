package com.cryptopulse.app.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class TradeAlertActionReceiver : BroadcastReceiver() {

    @Inject
    lateinit var tradeAlertManager: TradeAlertManager

    companion object {
        const val ACTION_SILENCE = "com.cryptopulse.app.action.SILENCE_TRADE_ALERT"
        const val ACTION_DISMISS = "com.cryptopulse.app.action.DISMISS_TRADE_ALERT"
        const val EXTRA_ALERT_ID = "alert_id"
    }

    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null) return
        val action = intent.action ?: return
        val alertId = intent.getStringExtra(EXTRA_ALERT_ID)
        handleAction(action, alertId)
    }

    fun handleAction(action: String, alertId: String?) {
        TradeAlertLogger.log("ACTION_RECEIVER", "Action received: $action for alertId: $alertId")
        when (action) {
            ACTION_SILENCE, ACTION_DISMISS -> {
                try {
                    tradeAlertManager.silenceHardware(alertId)
                } catch (e: Exception) {
                    TradeAlertLogger.error("ACTION_RECEIVER_ERROR", e)
                }
            }
        }
    }
}
