package com.cryptopulse.app.data.api

import com.cryptopulse.app.data.api.dto.auth.request.*
import com.cryptopulse.app.data.api.dto.auth.response.*
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

interface AuthService {
    @POST(ApiConstants.LOGIN)
    suspend fun login(@Body request: LoginRequestDto): Response<LoginResponseDto>

    @POST(ApiConstants.REGISTER)
    suspend fun register(@Body request: RegisterRequestDto): Response<RegisterResponseDto>

    @POST(ApiConstants.LOGOUT)
    suspend fun logout(): Response<LogoutResponseDto>

    @POST(ApiConstants.REFRESH)
    suspend fun refreshToken(@Body request: RefreshRequestDto): Response<RefreshResponseDto>
}
