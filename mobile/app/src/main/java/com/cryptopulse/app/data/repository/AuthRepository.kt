package com.cryptopulse.app.data.repository

import com.cryptopulse.app.data.api.AuthService
import com.cryptopulse.app.data.api.LoginRequest
import com.cryptopulse.app.data.api.RegisterRequest
import com.cryptopulse.app.data.api.RefreshRequest
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.domain.model.AuthResult
import kotlinx.coroutines.flow.first

class AuthRepository(
    private val api: AuthService,
    private val tokenManager: TokenManager
) {
    suspend fun register(email: String, password: String): AuthResult<Unit> {
        return try {
            val response = api.register(RegisterRequest(email, password, password))
            if (response.isSuccessful) {
                val body = response.body()
                if (body?.accessToken != null && body.refreshToken != null) {
                    tokenManager.saveTokens(body.accessToken, body.refreshToken)
                    AuthResult.Success(Unit)
                } else {
                    AuthResult.Error(body?.error ?: "Registration failed")
                }
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
            if (response.isSuccessful) {
                val body = response.body()
                if (body?.accessToken != null && body.refreshToken != null) {
                    tokenManager.saveTokens(body.accessToken, body.refreshToken)
                    AuthResult.Success(Unit)
                } else {
                    AuthResult.Error(body?.error ?: "Login failed")
                }
            } else {
                AuthResult.Error(response.body()?.error ?: "Login failed")
            }
        } catch (e: Exception) {
            AuthResult.Error(e.localizedMessage ?: "Unknown error occurred")
        }
    }

    suspend fun refreshToken(): AuthResult<Unit> {
        return try {
            val refreshToken = tokenManager.refreshTokenFlow.first()
            if (refreshToken.isNullOrEmpty()) {
                return AuthResult.Error("No refresh token available")
            }

            val response = api.refresh(RefreshRequest(refreshToken))
            if (response.isSuccessful) {
                val body = response.body()
                if (body?.accessToken != null && body.refreshToken != null) {
                    tokenManager.saveTokens(body.accessToken, body.refreshToken)
                    AuthResult.Success(Unit)
                } else {
                    AuthResult.Error(body?.error ?: "Token refresh failed")
                }
            } else {
                tokenManager.clearTokens()
                AuthResult.Error(response.body()?.error ?: "Token refresh failed")
            }
        } catch (e: Exception) {
            tokenManager.clearTokens()
            AuthResult.Error(e.localizedMessage ?: "Unknown error occurred")
        }
    }

    suspend fun logout() {
        try {
            val token = tokenManager.getToken()
            if (!token.isNullOrEmpty()) {
                val response = api.logout()
                if (!response.isSuccessful) {
                    // Proceed with local cleanup even if server call fails
                }
            }
        } catch (e: Exception) {
            // Proceed with local cleanup even if server call fails
        } finally {
            tokenManager.clearTokens()
        }
    }
}
