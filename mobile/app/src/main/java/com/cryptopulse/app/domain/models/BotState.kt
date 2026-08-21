package com.cryptopulse.app.domain.models

enum class BotState {
    NOT_STARTED,
    ACTIVATING,
    INITIALISING_MARKET_DATA,
    LOADING_STRATEGY,
    LOADING_INDICATORS,
    ANALYSING,
    WAITING_FOR_SIGNAL,
    SIGNAL_GENERATED,
    TRADE_PENDING,
    TRADE_EXECUTED,
    MONITORING_POSITION,
    STOPPING,
    STOPPED
}

data class BotStatus(
    val state: BotState,
    val isActive: Boolean,
    val coinId: String? = null,
    val strategy: String? = null
)

