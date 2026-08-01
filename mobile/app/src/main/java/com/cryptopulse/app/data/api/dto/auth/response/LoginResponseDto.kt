package com.cryptopulse.app.data.api.dto.auth.response

data class LoginResponseDto(val accessToken: String?, val refreshToken: String?, val error: String?)
