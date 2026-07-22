package com.cryptopulse.app.service

enum class TradeAlertState {
    IDLE,
    ALERT_TRIGGERED,
    VOICE_PLAYING,
    USER_VIEWING_ALERT,
    ALERT_REPLACED,
    STOPPING,
}
