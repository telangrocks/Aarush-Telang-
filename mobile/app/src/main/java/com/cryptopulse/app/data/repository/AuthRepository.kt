package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
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
                tokenManager.saveTokens(result.data.accessToken ?: "", result.data.refreshToken ?: "")
                NetworkResult.Success(Unit)
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun register(email: String, password: String, confirm: String): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        when (val result = authRemoteDataSource.register(RegisterRequestDto(email, password, confirm))) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
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
        val currentToken = tokenManager.tokenFlow.value ?: return@withContext NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Unknown(Exception("No token")))
        when (val result = authRemoteDataSource.refreshToken(RefreshRequestDto(currentToken))) {
            is NetworkResult.Success -> {
                tokenManager.saveTokens(result.data.accessToken ?: "", result.data.refreshToken ?: "")
                NetworkResult.Success(Unit)
            }
            is NetworkResult.Error -> {
                tokenManager.clearTokens()
                result
            }
        }
    }
}


