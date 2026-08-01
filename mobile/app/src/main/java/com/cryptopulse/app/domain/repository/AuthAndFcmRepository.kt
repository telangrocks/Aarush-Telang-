package com.cryptopulse.app.domain.repository

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*

interface AuthRepository {
    suspend fun login(email: String, password: String): NetworkResult<Unit>
    suspend fun register(email: String, password: String, confirm: String): NetworkResult<Unit>
    suspend fun logout(): NetworkResult<Unit>
    suspend fun refreshToken(): NetworkResult<Unit>
}

interface FcmRepository {
    suspend fun registerToken(token: String): NetworkResult<Unit>
}
