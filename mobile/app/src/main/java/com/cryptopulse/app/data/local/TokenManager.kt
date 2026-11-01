package com.cryptopulse.app.data.local

import android.content.Context
import android.util.Base64
import android.util.Log
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

sealed class TokenState {
    object Uninitialized : TokenState()
    object Loading : TokenState()
    data class Authenticated(val token: String) : TokenState()
    object Unauthenticated : TokenState()
}

val Context.tokenDataStore: DataStore<Preferences> by preferencesDataStore(name = "secure_token_prefs")

open class TokenManager(
    private val context: Context,
    customDataStore: DataStore<Preferences>? = null,
    customEncryptionManager: TokenEncryptionManager? = null
) {
    companion object {
        private const val TAG = "TokenManager"
        private const val LEGACY_PREFS_FILE = "secure_auth_prefs"

        private val KEY_ENCRYPTED_JWT = stringPreferencesKey("enc_jwt_token")
        private val KEY_ENCRYPTED_REFRESH = stringPreferencesKey("enc_refresh_token")
        private val KEY_FCM_TOKEN = stringPreferencesKey("fcm_token")
        private val KEY_REGISTRATION_COMPLETED = booleanPreferencesKey("has_completed_registration")
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val initDeferred = CompletableDeferred<Unit>()

    private val dataStore: DataStore<Preferences> by lazy {
        customDataStore ?: try {
            context.tokenDataStore
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to initialize Context.tokenDataStore: ${e.message}", e)
            throw e
        }
    }

    private val encryptionManager: TokenEncryptionManager by lazy {
        customEncryptionManager ?: TokenEncryptionManager(context)
    }

    private val _tokenFlow = MutableStateFlow<TokenState>(TokenState.Uninitialized)
    open val tokenFlow: StateFlow<TokenState> get() = _tokenFlow.asStateFlow()

    private val _refreshTokenFlow = MutableStateFlow<TokenState>(TokenState.Uninitialized)
    open val refreshTokenFlow: StateFlow<TokenState> get() = _refreshTokenFlow.asStateFlow()

    private val _fcmTokenFlow = MutableStateFlow<String?>(null)
    open val fcmTokenFlow: StateFlow<String?> get() = _fcmTokenFlow.asStateFlow()

    private val _isRegistrationCompletedFlow = MutableStateFlow<Boolean>(false)
    open val isRegistrationCompletedFlow: StateFlow<Boolean> get() = _isRegistrationCompletedFlow.asStateFlow()

    private val cachedHasToken = AtomicBoolean(false)
    private val cachedIsRegistered = AtomicBoolean(false)

    init {
        _tokenFlow.value = TokenState.Loading
        _refreshTokenFlow.value = TokenState.Loading

        scope.launch {
            try {
                // 1. One-time migration from legacy EncryptedSharedPreferences if present
                migrateLegacyStorageIfPresent()

                // 2. Load initial preferences from DataStore
                val initialPrefs = try {
                    dataStore.data.firstOrNull() ?: emptyPreferences()
                } catch (e: Throwable) {
                    if (e is CancellationException) throw e
                    Log.w(TAG, "Failed to read initial DataStore snapshot: ${e.message}")
                    emptyPreferences()
                }

                loadPreferencesIntoState(initialPrefs)
            } catch (e: Throwable) {
                if (e is CancellationException) throw e
                Log.e(TAG, "Storage initialization failed: ${e.message}", e)
                _tokenFlow.value = TokenState.Unauthenticated
                _refreshTokenFlow.value = TokenState.Unauthenticated
                _isRegistrationCompletedFlow.value = false
                cachedHasToken.set(false)
                cachedIsRegistered.set(false)
            } finally {
                initDeferred.complete(Unit)
            }

            // 3. Keep in-memory StateFlows in sync with continuous DataStore updates
            try {
                dataStore.data.collect { prefs ->
                    loadPreferencesIntoState(prefs)
                }
            } catch (e: Throwable) {
                if (e is CancellationException) throw e
                Log.w(TAG, "DataStore observation interrupted: ${e.message}")
            }
        }
    }

    /**
     * Decrypts tokens from DataStore preferences and updates in-memory StateFlows.
     * If encrypted tokens exist but cannot be decrypted (e.g. key loss/rotation),
     * recovers gracefully to TokenState.Unauthenticated without crashing.
     */
    private fun loadPreferencesIntoState(prefs: Preferences) {
        try {
            val encJwt = prefs[KEY_ENCRYPTED_JWT]
            val encRefresh = prefs[KEY_ENCRYPTED_REFRESH]
            val fcm = prefs[KEY_FCM_TOKEN]
            val regCompleted = prefs[KEY_REGISTRATION_COMPLETED] ?: false

            val jwt = if (!encJwt.isNullOrBlank()) encryptionManager.decrypt(encJwt) else null
            val refresh = if (!encRefresh.isNullOrBlank()) encryptionManager.decrypt(encRefresh) else null

            // If encrypted token existed but failed decryption, safely purge corrupted values
            if (!encJwt.isNullOrBlank() && jwt == null) {
                Log.w(TAG, "Corrupted or unrecoverable token ciphertext detected in DataStore. Resetting auth state.")
                scope.launch {
                    try {
                        dataStore.edit { it.remove(KEY_ENCRYPTED_JWT); it.remove(KEY_ENCRYPTED_REFRESH) }
                    } catch (_: Throwable) {}
                }
            }

            val isAuthenticated = !jwt.isNullOrBlank()
            _tokenFlow.value = if (isAuthenticated) TokenState.Authenticated(jwt!!) else TokenState.Unauthenticated
            _refreshTokenFlow.value = if (!refresh.isNullOrBlank()) TokenState.Authenticated(refresh) else TokenState.Unauthenticated
            _fcmTokenFlow.value = fcm
            _isRegistrationCompletedFlow.value = regCompleted

            cachedHasToken.set(isAuthenticated)
            cachedIsRegistered.set(regCompleted)
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            Log.e(TAG, "Error applying preferences to StateFlow: ${e.message}", e)
            _tokenFlow.value = TokenState.Unauthenticated
            _refreshTokenFlow.value = TokenState.Unauthenticated
            cachedHasToken.set(false)
        }
    }

    /**
     * Detects existing EncryptedSharedPreferences data and migrates it to DataStore.
     * If legacy storage is corrupted or unrecoverable (e.g., AEADBadTagException on Android 16),
     * recovers cleanly by deleting the obsolete file and requiring reauthentication.
     */
    private suspend fun migrateLegacyStorageIfPresent() = withContext(Dispatchers.IO) {
        try {
            val sharedPrefsDir = File(context.applicationInfo?.dataDir ?: return@withContext, "shared_prefs")
            val legacyFile = File(sharedPrefsDir, "$LEGACY_PREFS_FILE.xml")
            if (!legacyFile.exists()) return@withContext

            Log.i(TAG, "Detected legacy EncryptedSharedPreferences file. Attempting safe migration...")

            var migratedJwt: String? = null
            var migratedRefresh: String? = null
            var migratedFcm: String? = null
            var migratedRegistration = false

            try {
                val masterKey = MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()
                val legacyPrefs = EncryptedSharedPreferences.create(
                    context,
                    LEGACY_PREFS_FILE,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                )
                migratedJwt = legacyPrefs.getString("jwt_token", null)
                migratedRefresh = legacyPrefs.getString("refresh_token", null)
                migratedFcm = legacyPrefs.getString("fcm_token", null)
                migratedRegistration = legacyPrefs.getBoolean("has_completed_registration", false)
            } catch (e: Throwable) {
                Log.w(TAG, "Legacy storage decryption failed (${e.javaClass.simpleName}). Irrecoverable legacy data will be cleared.")
            }

            // Persist migrated data into DataStore
            if (!migratedJwt.isNullOrBlank() && !migratedRefresh.isNullOrBlank()) {
                val encJwt = encryptionManager.encrypt(migratedJwt)
                val encRefresh = encryptionManager.encrypt(migratedRefresh)
                dataStore.edit { prefs ->
                    prefs[KEY_ENCRYPTED_JWT] = encJwt
                    prefs[KEY_ENCRYPTED_REFRESH] = encRefresh
                    if (!migratedFcm.isNullOrBlank()) prefs[KEY_FCM_TOKEN] = migratedFcm
                    prefs[KEY_REGISTRATION_COMPLETED] = migratedRegistration
                }
                Log.i(TAG, "Legacy tokens successfully migrated to DataStore.")
            } else if (migratedRegistration) {
                dataStore.edit { prefs ->
                    prefs[KEY_REGISTRATION_COMPLETED] = true
                }
            }

            // Clean up legacy files permanently
            try {
                context.getSharedPreferences(LEGACY_PREFS_FILE, Context.MODE_PRIVATE).edit().clear().commit()
                if (legacyFile.exists()) legacyFile.delete()
                val bakFile = File(sharedPrefsDir, "$LEGACY_PREFS_FILE.bak")
                if (bakFile.exists()) bakFile.delete()
                Log.i(TAG, "Obsolete EncryptedSharedPreferences file removed from disk.")
            } catch (e: Throwable) {
                Log.w(TAG, "Could not delete legacy file: ${e.message}")
            }
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            Log.w(TAG, "Migration encountered non-fatal error: ${e.message}")
        }
    }

    /**
     * Fast synchronous check for registration status. Never throws.
     */
    open fun isRegistrationCompletedSync(): Boolean {
        return _isRegistrationCompletedFlow.value || cachedIsRegistered.get()
    }

    /**
     * Fast synchronous check for cached tokens. Never throws.
     */
    open fun hasCachedTokenSync(): Boolean {
        val state = _tokenFlow.value
        if (state is TokenState.Authenticated) return true
        if (state is TokenState.Unauthenticated) return false
        return cachedHasToken.get()
    }

    open suspend fun isRegistrationCompleted(): Boolean {
        initDeferred.await()
        return _isRegistrationCompletedFlow.value
    }

    open suspend fun markRegistrationCompleted() = withContext(Dispatchers.IO) {
        initDeferred.await()
        try {
            dataStore.edit { prefs ->
                prefs[KEY_REGISTRATION_COMPLETED] = true
            }
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            Log.e(TAG, "Failed to mark registration completed: ${e.message}", e)
        }
        _isRegistrationCompletedFlow.value = true
        cachedIsRegistered.set(true)
    }

    open suspend fun getToken(): String? {
        initDeferred.await()
        return (_tokenFlow.value as? TokenState.Authenticated)?.token
    }

    open suspend fun getRefreshToken(): String? {
        initDeferred.await()
        return (_refreshTokenFlow.value as? TokenState.Authenticated)?.token
    }

    open suspend fun getFcmToken(): String? {
        initDeferred.await()
        return _fcmTokenFlow.value
    }

    open suspend fun saveFcmToken(fcmToken: String) = withContext(Dispatchers.IO) {
        initDeferred.await()
        try {
            dataStore.edit { prefs ->
                prefs[KEY_FCM_TOKEN] = fcmToken
            }
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            Log.e(TAG, "Failed to save FCM token: ${e.message}", e)
        }
        _fcmTokenFlow.value = fcmToken
    }

    /**
     * Persists access and refresh tokens securely in DataStore using AES-256-GCM encryption.
     * Updates in-memory StateFlow immediately.
     */
    open suspend fun saveTokens(accessToken: String, refreshToken: String) = withContext(Dispatchers.IO) {
        initDeferred.await()
        val encAccess = encryptionManager.encrypt(accessToken)
        val encRefresh = encryptionManager.encrypt(refreshToken)

        try {
            dataStore.edit { prefs ->
                prefs[KEY_ENCRYPTED_JWT] = encAccess
                prefs[KEY_ENCRYPTED_REFRESH] = encRefresh
            }
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            Log.e(TAG, "DataStore write failed in saveTokens: ${e.message}", e)
            throw e
        }

        _tokenFlow.value = TokenState.Authenticated(accessToken)
        _refreshTokenFlow.value = TokenState.Authenticated(refreshToken)
        cachedHasToken.set(true)
    }

    /**
     * Clears authentication tokens from DataStore and resets StateFlows to Unauthenticated.
     */
    open suspend fun clearTokens() = withContext(Dispatchers.IO) {
        initDeferred.await()
        try {
            dataStore.edit { prefs ->
                prefs.remove(KEY_ENCRYPTED_JWT)
                prefs.remove(KEY_ENCRYPTED_REFRESH)
            }
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            Log.e(TAG, "DataStore edit failed in clearTokens: ${e.message}", e)
        }
        _tokenFlow.value = TokenState.Unauthenticated
        _refreshTokenFlow.value = TokenState.Unauthenticated
        cachedHasToken.set(false)
    }

    open fun isTokenExpired(token: String?): Boolean {
        if (token.isNullOrEmpty()) return true
        try {
            val parts = token.split(".")
            if (parts.size != 3) return true
            val payload = String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_PADDING))
            val json = JSONObject(payload)
            val exp = json.getLong("exp")
            return System.currentTimeMillis() / 1000 >= exp
        } catch (_: Exception) {
            return true
        }
    }

    fun getTokenExpiryMillis(token: String?): Long {
        if (token.isNullOrEmpty()) return 0
        try {
            val parts = token.split(".")
            if (parts.size != 3) return 0
            val payload = String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_PADDING))
            val json = JSONObject(payload)
            val exp = json.getLong("exp")
            return exp * 1000
        } catch (_: Exception) {
            return 0
        }
    }
}
