package com.cryptopulse.app.service

import android.util.Log

object TradeAlertLogger {
    private const val TAG = "TradeAlertEngine"

    fun log(event: String, details: String? = null) {
        val message = if (details != null) "[$event] $details" else "[$event]"
        Log.i(TAG, message)
    }

    fun error(event: String, throwable: Throwable? = null) {
        Log.e(TAG, "[$event] Error occurred", throwable)
    }
}
