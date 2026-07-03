package com.cryptopulse.data.remote

import com.cryptopulse.data.remote.dto.ActivateBotRequest
import com.cryptopulse.data.remote.dto.ApiKeyRequest
import com.cryptopulse.data.remote.dto.LoginRequest
import com.cryptopulse.data.remote.dto.AuthResponse
import com.cryptopulse.data.remote.dto.MarketCandidate
import com.cryptopulse.data.remote.dto.RegisterRequest
import com.cryptopulse.data.remote.dto.Strategy
import com.cryptopulse.data.remote.dto.VerifyOtpRequest
import retrofit2.Response
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface ApiService {
    @POST("api/register")
    suspend fun register(@Body request: RegisterRequest): Response<AuthResponse>

    @POST("api/verify-otp")
    suspend fun verifyOtp(@Body request: VerifyOtpRequest): Response<AuthResponse>

    @POST("api/login")
    suspend fun login(@Body request: LoginRequest): Response<AuthResponse>

    @GET("api/market/candidates")
    suspend fun getMarketCandidates(): Response<List<MarketCandidate>>

    @GET("api/strategies")
    suspend fun getStrategies(): Response<List<Strategy>>

    @POST("api/bot/activate")
    suspend fun activateBot(@Body request: ActivateBotRequest): Response<Unit>

    @POST("api/bot/execute-trade")
    suspend fun executeTrade(): Response<Unit>

    @POST("api/bot/stop-trade")
    suspend fun stopTrade(): Response<Unit>

    @POST("api/exchange/keys")
    suspend fun submitApiKeys(@Body request: ApiKeyRequest): Response<Unit>
}