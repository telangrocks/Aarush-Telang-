package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

data class RegisterRequest(
    val email: String,
    val password: String,
    val confirmPassword: String,
)
data class RegisterResponse(val message: String?, val token: String?, val error: String?)

data class LoginRequest(val email: String, val password: String)
data class LoginResponse(val token: String?, val error: String?)

interface AuthService {
    @POST("/api/register")
    suspend fun register(@Body request: RegisterRequest): Response<RegisterResponse>

    @POST("/api/login")
    suspend fun login(@Body request: LoginRequest): Response<LoginResponse>
}
