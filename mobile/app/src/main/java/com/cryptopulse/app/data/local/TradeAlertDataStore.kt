package com.cryptopulse.app.data.local

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TradeAlertDataStore @Inject constructor(private val dataStore: DataStore<Preferences>) {
    companion object {
        val ACTIVE_ALERT_KEY = stringPreferencesKey("active_trade_alert")
    }

    private val gson = Gson()

    suspend fun saveActiveAlert(alertData: Map<String, Any>?) {
        dataStore.edit { preferences ->
            if (alertData == null) {
                preferences.remove(ACTIVE_ALERT_KEY)
            } else {
                preferences[ACTIVE_ALERT_KEY] = gson.toJson(alertData)
            }
        }
    }

    fun getActiveAlertFlow(): Flow<Map<String, Any>?> {
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
}
