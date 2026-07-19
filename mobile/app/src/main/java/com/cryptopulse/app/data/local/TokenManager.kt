package com.cryptopulse.app.data.local

import android.content.Context
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

class TokenManager(context: Context) {
    companion object {
        private const val PREFS_FILE = "secure_auth_prefs"
        private const val JWT_TOKEN_KEY = "jwt_token"
        private const val REFRESH_TOKEN_KEY = "refresh_token"
    }

    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val sharedPreferences = EncryptedSharedPreferences.create(
        context,
        PREFS_FILE,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    private val _tokenFlow = MutableStateFlow<String?>(sharedPreferences.getString(JWT_TOKEN_KEY, null))
    val tokenFlow: StateFlow<String?> = _tokenFlow.asStateFlow()

    private val _refreshTokenFlow = MutableStateFlow<String?>(sharedPreferences.getString(REFRESH_TOKEN_KEY, null))
    val refreshTokenFlow: StateFlow<String?> = _refreshTokenFlow.asStateFlow()

    suspend fun getToken(): String? {
        return sharedPreferences.getString(JWT_TOKEN_KEY, null)
    }

    suspend fun getRefreshToken(): String? {
        return sharedPreferences.getString(REFRESH_TOKEN_KEY, null)
    }

    suspend fun saveTokens(accessToken: String, refreshToken: String) {
        sharedPreferences.edit().putString(JWT_TOKEN_KEY, accessToken).apply()
        sharedPreferences.edit().putString(REFRESH_TOKEN_KEY, refreshToken).apply()
        _tokenFlow.value = accessToken
        _refreshTokenFlow.value = refreshToken
    }

    suspend fun clearTokens() {
        sharedPreferences.edit().remove(JWT_TOKEN_KEY).apply()
        sharedPreferences.edit().remove(REFRESH_TOKEN_KEY).apply()
        _tokenFlow.value = null
        _refreshTokenFlow.value = null
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
