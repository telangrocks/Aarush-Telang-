package com.cryptopulse.app.data.datasource.remote.auth

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.network.safeApiCall
import com.cryptopulse.app.data.api.AuthService
import com.cryptopulse.app.data.api.dto.auth.request.*
import com.cryptopulse.app.data.api.dto.auth.response.*
import javax.inject.Inject

interface AuthRemoteDataSource {
    suspend fun login(request: LoginRequestDto): NetworkResult<LoginResponseDto>
    suspend fun register(request: RegisterRequestDto): NetworkResult<RegisterResponseDto>
    suspend fun logout(): NetworkResult<LogoutResponseDto>
    suspend fun refreshToken(request: RefreshRequestDto): NetworkResult<RefreshResponseDto>
}

class RetrofitAuthRemoteDataSource @Inject constructor(
    private val authService: AuthService
) : AuthRemoteDataSource {
    override suspend fun login(request: LoginRequestDto): NetworkResult<LoginResponseDto> =
        safeApiCall { authService.login(request) }

    override suspend fun register(request: RegisterRequestDto): NetworkResult<RegisterResponseDto> =
        safeApiCall { authService.register(request) }

    override suspend fun logout(): NetworkResult<LogoutResponseDto> =
        safeApiCall { authService.logout() }

    override suspend fun refreshToken(request: RefreshRequestDto): NetworkResult<RefreshResponseDto> =
        safeApiCall { authService.refreshToken(request) }
}
