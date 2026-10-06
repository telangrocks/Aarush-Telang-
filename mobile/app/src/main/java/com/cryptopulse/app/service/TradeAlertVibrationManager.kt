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
            // Finite waveform bounded to TRADE_ALERT_HARDWARE_TIMEOUT_MS (30 seconds)
            // 30 cycles of (700ms on, 300ms off) = 30,000ms. repeat = -1 (DO NOT REPEAT)
            val timings = LongArray(61).apply {
                this[0] = 0L // initial delay
                for (i in 1..30) {
                    this[2 * i - 1] = 700L // vibrate
                    this[2 * i] = 300L     // pause
                }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val effect = VibrationEffect.createWaveform(timings, -1) // -1 = DO NOT REPEAT
                vibrator.vibrate(effect)
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(timings, -1)
            }
            TradeAlertLogger.log("VIBRATION_STARTED", "Finite 30s (700ms/300ms x30) pattern active (repeat = -1)")
        } catch (e: Exception) {
            isVibrating = false
            TradeAlertLogger.error("VIBRATION_ERROR", e)
        }
    }

    @Synchronized
    fun stopVibration() {
        if (!isVibrating) return
        isVibrating = false
        try {
            vibrator.cancel()
            TradeAlertLogger.log("VIBRATION_STOPPED", "Vibration cancelled")
        } catch (e: Exception) {
            TradeAlertLogger.error("VIBRATION_STOP_ERROR", e)
        }
    }
}
