package com.cryptopulse.app.service

import android.content.Context

enum class AlertVoicePack {
    FEMALE_EN_V1
}

interface AlertAudioProvider {
    fun getAudioResourceId(context: Context, voicePack: AlertVoicePack = AlertVoicePack.FEMALE_EN_V1): Int
}

class DefaultAlertAudioProvider : AlertAudioProvider {
    override fun getAudioResourceId(context: Context, voicePack: AlertVoicePack): Int {
        val resourceName = when (voicePack) {
            AlertVoicePack.FEMALE_EN_V1 -> "trade_detected"
        }
        return context.resources.getIdentifier(resourceName, "raw", context.packageName)
    }
}
