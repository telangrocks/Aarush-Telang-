package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.auth.request.*
import com.cryptopulse.app.data.datasource.remote.auth.AuthRemoteDataSource
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.domain.repository.AuthRepository
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AuthRepositoryImpl @Inject constructor(
    private val authRemoteDataSource: AuthRemoteDataSource,
    private val dispatcherProvider: DispatcherProvider,
    private val tokenManager: TokenManager
) : AuthRepository {
    override suspend fun login(email: String, password: String): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        when (val result = authRemoteDataSource.login(LoginRequestDto(email, password))) {
            is NetworkResult.Success -> {
                val access = result.data.accessToken
                val refresh = result.data.refreshToken
                if (!access.isNullOrBlank() && !refresh.isNullOrBlank()) {
                    tokenManager.saveTokens(access, refresh)
                    NetworkResult.Success(Unit)
                } else {
                    NetworkResult.Error(NetworkError.Serialization)
                }
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun register(email: String, password: String, confirm: String): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        when (val result = authRemoteDataSource.register(RegisterRequestDto(email, password, confirm))) {
            is NetworkResult.Success -> {
                val access = result.data.accessToken
                val refresh = result.data.refreshToken
                if (!access.isNullOrBlank() && !refresh.isNullOrBlank()) {
                    tokenManager.saveTokens(access, refresh)
                    NetworkResult.Success(Unit)
                } else {
                    NetworkResult.Error(NetworkError.Serialization)
                }
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun logout(): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        when (val result = authRemoteDataSource.logout()) {
            is NetworkResult.Success -> {
                tokenManager.clearTokens()
                NetworkResult.Success(Unit)
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun refreshToken(): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        val refreshToken = tokenManager.getRefreshToken()
        if (refreshToken.isNullOrBlank()) {
            return@withContext NetworkResult.Error(NetworkError.Unknown(Exception("No refresh token available")))
        }
        when (val result = authRemoteDataSource.refreshToken(RefreshRequestDto(refreshToken))) {
            is NetworkResult.Success -> {
                val access = result.data.accessToken
                val newRefresh = result.data.refreshToken
                if (!access.isNullOrBlank() && !newRefresh.isNullOrBlank()) {
                    tokenManager.saveTokens(access, newRefresh)
                    NetworkResult.Success(Unit)
                } else {
                    tokenManager.clearTokens()
                    NetworkResult.Error(NetworkError.Serialization)
                }
            }
            is NetworkResult.Error -> {
                // Only clear tokens on fatal 401/403 authentication failures (invalid/expired/revoked refresh token)
                // Do NOT clear tokens on transient network drops or temporary 5xx server errors
                if (result.error is NetworkError.HttpError && (result.error.code == 401 || result.error.code == 403)) {
                    tokenManager.clearTokens()
                }
                result
            }
        }
    }
}


