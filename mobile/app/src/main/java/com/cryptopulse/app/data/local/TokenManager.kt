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

    suspend fun getToken(): String? {
        return sharedPreferences.getString(JWT_TOKEN_KEY, null)
    }

    suspend fun saveToken(token: String) {
        sharedPreferences.edit().putString(JWT_TOKEN_KEY, token).apply()
        _tokenFlow.value = token
    }

    suspend fun clearToken() {
        sharedPreferences.edit().remove(JWT_TOKEN_KEY).apply()
        _tokenFlow.value = null
    }
}
