package com.cryptopulse.app.data.api

import com.cryptopulse.app.data.api.dto.exchange.request.*
import com.cryptopulse.app.data.api.dto.exchange.response.*
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface ExchangeService {
    @POST(ApiConstants.EXCHANGE_VALIDATE)
    suspend fun validateKeys(@Body request: ValidateExchangeRequestDto): Response<ValidationResponseDto>

    @POST(ApiConstants.EXCHANGE_CONNECT)
    suspend fun connectExchange(@Body request: ConnectExchangeRequestDto): Response<ConnectExchangeResponseDto>

    @GET(ApiConstants.EXCHANGE_STATUS)
    suspend fun getConnectionStatus(): Response<ExchangeStatusResponseDto>

    @GET(ApiConstants.EXCHANGE_BALANCE)
    suspend fun getBalances(): Response<ExchangeBalanceResponseDto>
}
