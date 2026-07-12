package com.cryptopulse.app.service

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

object AlertBus {
    private val _alerts = MutableSharedFlow<Map<String, Any>>()
    val alerts: SharedFlow<Map<String, Any>> = _alerts

    suspend fun send(alert: Map<String, Any>) {
        _alerts.emit(alert)
    }
}
