package com.cryptopulse.app.data.api.dto.auth.request

data class RegisterRequestDto(
    val email: String,
    val password: String,
    val confirmPassword: String,
)
