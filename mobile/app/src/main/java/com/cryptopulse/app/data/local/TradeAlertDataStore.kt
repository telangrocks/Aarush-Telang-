package com.cryptopulse.app.data.local

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

data class HandledAlertRecord(
    val alertId: String,
    val hardwareState: String, // "HARDWARE_ACTIVE", "HARDWARE_SILENCED", "RESOLVED"
    val timestamp: Long = System.currentTimeMillis()
)

@Singleton
open class TradeAlertDataStore @Inject constructor(private val dataStore: DataStore<Preferences>) {
    constructor() : this(object : DataStore<Preferences> {
        override val data: Flow<Preferences> = kotlinx.coroutines.flow.emptyFlow()
        override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences = throw UnsupportedOperationException()
    })

    companion object {
        val ACTIVE_ALERT_KEY = stringPreferencesKey("active_trade_alert")
        val HANDLED_ALERT_HISTORY_KEY = stringPreferencesKey("handled_alert_history")
    }

    private val gson = Gson()
    private val inMemoryHistory = java.util.concurrent.ConcurrentHashMap<String, HandledAlertRecord>()

    open suspend fun saveActiveAlert(alertData: Map<String, Any>?) {
        try {
            dataStore.edit { preferences ->
                if (alertData == null) {
                    preferences.remove(ACTIVE_ALERT_KEY)
                } else {
                    preferences[ACTIVE_ALERT_KEY] = gson.toJson(alertData)
                }
            }
        } catch (_: Throwable) {}
    }

    open fun getActiveAlertFlow(): Flow<Map<String, Any>?> {
        return dataStore.data.map { preferences ->
            val json = preferences[ACTIVE_ALERT_KEY]
            if (json != null) {
                val type = object : TypeToken<Map<String, Any>>() {}.type
                gson.fromJson<Map<String, Any>>(json, type)
            } else {
                null
            }
        }
    }

    open suspend fun recordAlertHardwareState(alertId: String, state: String) {
        val record = HandledAlertRecord(alertId = alertId, hardwareState = state, timestamp = System.currentTimeMillis())
        inMemoryHistory[alertId] = record
        try {
            dataStore.edit { preferences ->
                val json = preferences[HANDLED_ALERT_HISTORY_KEY]
                val mapType = object : TypeToken<MutableMap<String, HandledAlertRecord>>() {}.type
                val history: MutableMap<String, HandledAlertRecord> = if (json != null) {
                    try {
                        gson.fromJson(json, mapType) ?: mutableMapOf()
                    } catch (_: Exception) {
                        mutableMapOf()
                    }
                } else {
                    mutableMapOf()
                }
                val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
                val pruned = history.filterValues { it.timestamp >= cutoff }.toMutableMap()
                pruned[alertId] = record
                preferences[HANDLED_ALERT_HISTORY_KEY] = gson.toJson(pruned)
            }
        } catch (_: Throwable) {}
    }

    open suspend fun getHandledAlertHistory(): Map<String, HandledAlertRecord> {
        return try {
            val prefs = dataStore.data.firstOrNull()
            val json = prefs?.get(HANDLED_ALERT_HISTORY_KEY)
            if (json != null) {
                val mapType = object : TypeToken<Map<String, HandledAlertRecord>>() {}.type
                val fromDisk: Map<String, HandledAlertRecord> = gson.fromJson(json, mapType) ?: emptyMap()
                inMemoryHistory.putAll(fromDisk)
                inMemoryHistory
            } else {
                inMemoryHistory
            }
        } catch (_: Throwable) {
            inMemoryHistory
        }
    }

    open fun getHandledAlertHistoryFlow(): Flow<Map<String, HandledAlertRecord>> {
        return dataStore.data.map { preferences ->
            val json = preferences[HANDLED_ALERT_HISTORY_KEY]
            if (json != null) {
                try {
                    val mapType = object : TypeToken<Map<String, HandledAlertRecord>>() {}.type
                    gson.fromJson<Map<String, HandledAlertRecord>>(json, mapType) ?: inMemoryHistory
                } catch (_: Exception) {
                    inMemoryHistory
                }
            } else {
                inMemoryHistory
            }
        }
    }
}
