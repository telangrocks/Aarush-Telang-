package com.cryptopulse.app.data.datasource.remote.exchange

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.network.safeApiCall
import com.cryptopulse.app.data.api.ExchangeService
import com.cryptopulse.app.data.api.dto.exchange.request.*
import com.cryptopulse.app.data.api.dto.exchange.response.*
import javax.inject.Inject

interface ExchangeRemoteDataSource {
    suspend fun validateKeys(request: ValidateExchangeRequestDto): NetworkResult<ValidationResponseDto>
    suspend fun connectExchange(request: ConnectExchangeRequestDto): NetworkResult<ConnectExchangeResponseDto>
    suspend fun getConnectionStatus(): NetworkResult<ExchangeStatusResponseDto>
    suspend fun getBalances(): NetworkResult<ExchangeBalanceResponseDto>
}

class RetrofitExchangeRemoteDataSource @Inject constructor(
    private val exchangeService: ExchangeService
) : ExchangeRemoteDataSource {
    override suspend fun validateKeys(request: ValidateExchangeRequestDto): NetworkResult<ValidationResponseDto> =
        safeApiCall { exchangeService.validateKeys(request) }

    override suspend fun connectExchange(request: ConnectExchangeRequestDto): NetworkResult<ConnectExchangeResponseDto> =
        safeApiCall { exchangeService.connectExchange(request) }

    override suspend fun getConnectionStatus(): NetworkResult<ExchangeStatusResponseDto> =
        safeApiCall { exchangeService.getConnectionStatus() }

    override suspend fun getBalances(): NetworkResult<ExchangeBalanceResponseDto> =
        safeApiCall { exchangeService.getBalances() }
}
