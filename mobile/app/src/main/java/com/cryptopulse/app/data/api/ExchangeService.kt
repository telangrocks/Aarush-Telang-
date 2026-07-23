package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
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
    val code: String? = null,
    val hint: String? = null,
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
    val code: String? = null,
    val hint: String? = null,
)

data class ExchangeStatusResponse(
    val isConnected: Boolean,
    val exchangeName: String?,
    val environment: String?,
    val region: String? = null,
)

data class BalanceItemData(
    val asset: String,
    val free: Double,
    val locked: Double,
    val total: Double
)

data class ExchangeBalanceResponse(
    val success: Boolean,
    val exchange: String? = null,
    val environment: String? = null,
    val primaryAsset: String? = "USDT",
    val balances: List<BalanceItemData>? = null,
    val code: String? = null,
    val message: String? = null,
    val hint: String? = null
)

interface ExchangeService {
    @POST("/api/exchange/validate")
    suspend fun validate(@Body request: ValidateExchangeRequest): Response<ValidationResponse>

    @POST("/api/exchange/connect")
    suspend fun connect(@Body request: ConnectExchangeRequest): Response<ConnectExchangeResponse>

    @GET("/api/exchange/status")
    suspend fun getStatus(): Response<ExchangeStatusResponse>

    @GET("/api/exchange/balance")
    suspend fun getBalance(): Response<ExchangeBalanceResponse>
}
