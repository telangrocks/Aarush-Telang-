package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

data class ValidateExchangeRequest(
    val exchangeName: String,
    val apiKey: String,
    val apiSecret: String,
    val environment: String = "mainnet",
)

data class ValidationResponse(
    val success: Boolean,
    val message: String,
)

data class ConnectExchangeRequest(
    val exchangeName: String,
    val apiKey: String,
    val apiSecret: String,
    val environment: String = "mainnet",
)

data class ConnectExchangeResponse(
    val success: Boolean,
    val message: String,
    val exchangeName: String?,
    val environment: String? = null,
)

interface ExchangeService {
    @POST("/api/exchange/validate")
    suspend fun validate(@Body request: ValidateExchangeRequest): Response<ValidationResponse>

    @POST("/api/exchange/connect")
    suspend fun connect(@Body request: ConnectExchangeRequest): Response<ConnectExchangeResponse>
}
