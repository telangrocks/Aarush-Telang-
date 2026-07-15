package com.cryptopulse.app.data.repository

import com.cryptopulse.app.data.api.AuthService
import com.cryptopulse.app.data.api.LoginRequest
import com.cryptopulse.app.data.api.RegisterRequest
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.domain.model.AuthResult

class AuthRepository(
    private val api: AuthService,
    private val tokenManager: TokenManager
) {
    suspend fun register(email: String, password: String): AuthResult<Unit> {
        return try {
            val response = api.register(RegisterRequest(email, password, password))
            if (response.isSuccessful && response.body()?.token != null) {
                tokenManager.saveToken(response.body()!!.token!!)
                AuthResult.Success(Unit)
            } else {
                AuthResult.Error(response.body()?.error ?: "Registration failed")
            }
        } catch (e: Exception) {
            AuthResult.Error(e.localizedMessage ?: "Unknown error occurred")
        }
    }

    suspend fun login(email: String, password: String): AuthResult<Unit> {
        return try {
            val response = api.login(LoginRequest(email, password))
            if (response.isSuccessful && response.body()?.token != null) {
                tokenManager.saveToken(response.body()!!.token!!)
                AuthResult.Success(Unit)
            } else {
                AuthResult.Error(response.body()?.error ?: "Login failed")
            }
        } catch (e: Exception) {
            AuthResult.Error(e.localizedMessage ?: "Unknown error occurred")
        }
    }

    suspend fun logout() {
        tokenManager.clearToken()
    }
}
