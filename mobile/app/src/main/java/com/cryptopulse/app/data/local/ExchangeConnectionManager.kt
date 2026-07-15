package com.cryptopulse.app.data.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map

val Context.exchangeDataStore: DataStore<Preferences> by preferencesDataStore(name = "exchange_prefs")

class ExchangeConnectionManager(private val context: Context) {

    companion object {
        private val IS_CONNECTED = booleanPreferencesKey("is_exchange_connected")
        private val EXCHANGE_NAME = stringPreferencesKey("exchange_name")
        private val EXCHANGE_ENVIRONMENT = stringPreferencesKey("exchange_environment")
    }

    val isConnected: Flow<Boolean> = context.exchangeDataStore.data.map { prefs ->
        prefs[IS_CONNECTED] ?: false
    }

    val exchangeName: Flow<String?> = context.exchangeDataStore.data.map { prefs ->
        prefs[EXCHANGE_NAME]
    }

    val exchangeEnvironment: Flow<String?> = context.exchangeDataStore.data.map { prefs ->
        prefs[EXCHANGE_ENVIRONMENT]
    }

    suspend fun saveConnection(exchangeName: String, environment: String) {
        context.exchangeDataStore.edit { prefs ->
            prefs[IS_CONNECTED] = true
            prefs[EXCHANGE_NAME] = exchangeName
            prefs[EXCHANGE_ENVIRONMENT] = environment
        }
    }

    suspend fun clearConnection() {
        context.exchangeDataStore.edit { prefs ->
            prefs.remove(IS_CONNECTED)
            prefs.remove(EXCHANGE_NAME)
            prefs.remove(EXCHANGE_ENVIRONMENT)
        }
    }

    suspend fun getConnectionInfo(): Triple<Boolean, String?, String?> {
        val prefs = context.exchangeDataStore.data.firstOrNull()
        val isConnected = prefs?.get(IS_CONNECTED) ?: false
        val name = prefs?.get(EXCHANGE_NAME)
        val env = prefs?.get(EXCHANGE_ENVIRONMENT)
        return Triple(isConnected, name, env)
    }
}
