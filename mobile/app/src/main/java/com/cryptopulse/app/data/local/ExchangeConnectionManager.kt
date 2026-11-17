package com.cryptopulse.app.data.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map

val Context.exchangeDataStore: DataStore<Preferences> by preferencesDataStore(name = "exchange_prefs")

open class ExchangeConnectionManager(private val context: Context) {

    companion object {
        private val IS_CONNECTED = booleanPreferencesKey("is_exchange_connected")
        private val EXCHANGE_NAME = stringPreferencesKey("exchange_name")
        private val EXCHANGE_ENVIRONMENT = stringPreferencesKey("exchange_environment")

        fun normalizeEnvironment(raw: String?): String? {
            return when (raw?.trim()?.lowercase()) {
                "mainnet", "real", "live", "production" -> "mainnet"
                "demo" -> "demo"
                else -> null
            }
        }

        fun normalizeExchangeName(raw: String?): String {
            val cleaned = raw?.trim()?.lowercase()
            return if (cleaned.isNullOrEmpty()) "bybit" else cleaned
        }
    }

    private val _connectionState = MutableStateFlow<Triple<Boolean, String?, String?>?>(null)
    val connectionState: StateFlow<Triple<Boolean, String?, String?>?> = _connectionState.asStateFlow()

    fun notifyConnectionRestored(exchangeName: String?, environment: String?) {
        val canonicalEnv = normalizeEnvironment(environment) ?: return
        val canonicalExchange = normalizeExchangeName(exchangeName)
        _connectionState.value = Triple(true, canonicalExchange, canonicalEnv)
    }

    fun notifyConnectionCleared() {
        _connectionState.value = Triple(false, null, null)
    }

    open val isConnected: Flow<Boolean> = context.exchangeDataStore.data.map { prefs ->
        prefs[IS_CONNECTED] ?: false
    }

    open val exchangeName: Flow<String?> = context.exchangeDataStore.data.map { prefs ->
        prefs[EXCHANGE_NAME]?.let { normalizeExchangeName(it) }
    }

    open val exchangeEnvironment: Flow<String?> = context.exchangeDataStore.data.map { prefs ->
        normalizeEnvironment(prefs[EXCHANGE_ENVIRONMENT])
    }

    open suspend fun saveConnection(exchangeName: String, environment: String) {
        val canonicalExchange = normalizeExchangeName(exchangeName)
        val canonicalEnv = normalizeEnvironment(environment) ?: return
        _connectionState.value = Triple(true, canonicalExchange, canonicalEnv)
        context.exchangeDataStore.edit { prefs ->
            prefs[IS_CONNECTED] = true
            prefs[EXCHANGE_NAME] = canonicalExchange
            prefs[EXCHANGE_ENVIRONMENT] = canonicalEnv
        }
    }

    open suspend fun clearConnection() {
        _connectionState.value = Triple(false, null, null)
        context.exchangeDataStore.edit { prefs ->
            prefs.remove(IS_CONNECTED)
            prefs.remove(EXCHANGE_NAME)
            prefs.remove(EXCHANGE_ENVIRONMENT)
        }
    }

    open suspend fun getConnectionInfo(): Triple<Boolean, String?, String?> {
        val prefs = context.exchangeDataStore.data.firstOrNull()
        val isConnected = prefs?.get(IS_CONNECTED) ?: false
        val name = prefs?.get(EXCHANGE_NAME)
        val env = prefs?.get(EXCHANGE_ENVIRONMENT)
        val canonicalEnv = normalizeEnvironment(env)
        val canonicalName = normalizeExchangeName(name)

        // Logical invalidation: Require reconnect if legacy exchange (Binance/KuCoin), Testnet, or missing/invalid canonical environment
        if (!isConnected || !"bybit".equals(canonicalName, ignoreCase = true) || canonicalEnv == null) {
            return Triple(false, null, null)
        }

        _connectionState.value = Triple(true, canonicalName, canonicalEnv)
        return Triple(true, canonicalName, canonicalEnv)
    }
}
