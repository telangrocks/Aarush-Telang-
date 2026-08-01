package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.exchange.request.*
import com.cryptopulse.app.data.datasource.remote.exchange.ExchangeRemoteDataSource
import com.cryptopulse.app.data.mapper.exchange.toDomain
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.ExchangeRepository
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ExchangeRepositoryImpl @Inject constructor(
    private val exchangeRemoteDataSource: ExchangeRemoteDataSource,
    private val dispatcherProvider: DispatcherProvider
) : ExchangeRepository {

    override suspend fun validateKeys(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        val request = ValidateExchangeRequestDto(exchangeName, apiKey, apiSecret, apiPassphrase, environment)
        when (val result = exchangeRemoteDataSource.validateKeys(request)) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> result
        }
    }

    override suspend fun connectExchange(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        val request = ConnectExchangeRequestDto(exchangeName, apiKey, apiSecret, apiPassphrase, environment)
        when (val result = exchangeRemoteDataSource.connectExchange(request)) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> result
        }
    }

    override suspend fun getConnectionStatus(): NetworkResult<ExchangeStatus> = withContext(dispatcherProvider.io) {
        when (val result = exchangeRemoteDataSource.getConnectionStatus()) {
            is NetworkResult.Success -> {
                val state = if (result.data.isConnected) ExchangeStatus(isConnected = true, exchangeName = null, environment = null, region = null) else ExchangeStatus(isConnected = false, exchangeName = null, environment = null, region = null)
                NetworkResult.Success(state)
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun getBalances(): NetworkResult<List<BalanceItem>> = withContext(dispatcherProvider.io) {
        when (val result = exchangeRemoteDataSource.getBalances()) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.balances?.map { it.toDomain() } ?: emptyList())
            is NetworkResult.Error -> result
        }
    }
}


