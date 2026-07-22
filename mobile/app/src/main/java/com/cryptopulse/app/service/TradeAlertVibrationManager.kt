package com.cryptopulse.app.service

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

class TradeAlertVibrationManager(private val context: Context) {

    private val vibrator: Vibrator by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vibratorManager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
    }

    private var isVibrating = false

    @Synchronized
    fun startVibration() {
        if (isVibrating) return
        try {
            if (!vibrator.hasVibrator()) return
            isVibrating = true
            val timings = longArrayOf(0, 700, 300)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val effect = VibrationEffect.createWaveform(timings, 1) // repeat from index 1 (700ms on, 300ms off)
                vibrator.vibrate(effect)
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(timings, 1)
            }
            TradeAlertLogger.log("VIBRATION_STARTED", "Custom 700ms/300ms pattern active")
        } catch (e: Exception) {
            TradeAlertLogger.error("VIBRATION_ERROR", e)
        }
    }

    @Synchronized
    fun stopVibration() {
        if (!isVibrating) return
        try {
            vibrator.cancel()
            isVibrating = false
            TradeAlertLogger.log("VIBRATION_STOPPED", "Vibration cancelled")
        } catch (e: Exception) {
            TradeAlertLogger.error("VIBRATION_STOP_ERROR", e)
        }
    }
}
