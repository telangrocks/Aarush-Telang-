package com.cryptopulse.app.data.local

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class TokenManager(context: Context) {
    companion object {
        private const val PREFS_FILE = "secure_auth_prefs"
        private const val JWT_TOKEN_KEY = "jwt_token"
        private const val REFRESH_TOKEN_KEY = "refresh_token"
    }

    private val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)

    private val sharedPreferences = EncryptedSharedPreferences.create(
        PREFS_FILE,
        masterKeyAlias,
        context,
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
}
