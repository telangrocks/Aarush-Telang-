package com.cryptopulse.app.data.local

import android.content.Context
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

sealed class TokenState {
    object Uninitialized : TokenState()
    object Loading : TokenState()
    data class Authenticated(val token: String) : TokenState()
    object Unauthenticated : TokenState()
}

class TokenManager(context: Context) {
    companion object {
        private const val PREFS_FILE = "secure_auth_prefs"
        private const val JWT_TOKEN_KEY = "jwt_token"
        private const val REFRESH_TOKEN_KEY = "refresh_token"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val initDeferred = CompletableDeferred<Unit>()

    private val masterKey by lazy {
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
    }

    private val sharedPreferences by lazy {
        EncryptedSharedPreferences.create(
            context,
            PREFS_FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    private val _tokenFlow = MutableStateFlow<TokenState>(TokenState.Uninitialized)
    val tokenFlow: StateFlow<TokenState> = _tokenFlow.asStateFlow()

    private val _refreshTokenFlow = MutableStateFlow<TokenState>(TokenState.Uninitialized)
    val refreshTokenFlow: StateFlow<TokenState> = _refreshTokenFlow.asStateFlow()

    init {
        _tokenFlow.value = TokenState.Loading
        _refreshTokenFlow.value = TokenState.Loading
        scope.launch {
            try {
                val token = sharedPreferences.getString(JWT_TOKEN_KEY, null)
                val refresh = sharedPreferences.getString(REFRESH_TOKEN_KEY, null)
                
                _tokenFlow.value = if (token != null) TokenState.Authenticated(token) else TokenState.Unauthenticated
                _refreshTokenFlow.value = if (refresh != null) TokenState.Authenticated(refresh) else TokenState.Unauthenticated
            } catch (e: Exception) {
                _tokenFlow.value = TokenState.Unauthenticated
                _refreshTokenFlow.value = TokenState.Unauthenticated
            } finally {
                initDeferred.complete(Unit)
            }
        }
    }

    suspend fun getToken(): String? {
        initDeferred.await()
        return (_tokenFlow.value as? TokenState.Authenticated)?.token
    }

    suspend fun getRefreshToken(): String? {
        initDeferred.await()
        return (_refreshTokenFlow.value as? TokenState.Authenticated)?.token
    }

    suspend fun saveTokens(accessToken: String, refreshToken: String) = withContext(Dispatchers.IO) {
        initDeferred.await() // Ensure initialization is done before editing
        sharedPreferences.edit()
            .putString(JWT_TOKEN_KEY, accessToken)
            .putString(REFRESH_TOKEN_KEY, refreshToken)
            .apply()
        _tokenFlow.value = TokenState.Authenticated(accessToken)
        _refreshTokenFlow.value = TokenState.Authenticated(refreshToken)
    }

    suspend fun clearTokens() = withContext(Dispatchers.IO) {
        initDeferred.await()
        sharedPreferences.edit()
            .remove(JWT_TOKEN_KEY)
            .remove(REFRESH_TOKEN_KEY)
            .apply()
        _tokenFlow.value = TokenState.Unauthenticated
        _refreshTokenFlow.value = TokenState.Unauthenticated
    }

    fun isTokenExpired(token: String?): Boolean {
        if (token.isNullOrEmpty()) return true
        try {
            val parts = token.split(".")
            if (parts.size != 3) return true
            val payload = String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_PADDING))
            val json = JSONObject(payload)
            val exp = json.getLong("exp")
            return System.currentTimeMillis() / 1000 >= exp
        } catch (e: Exception) {
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
        } catch (e: Exception) {
            return 0
        }
    }
}
