package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.exchange.request.*
import com.cryptopulse.app.data.datasource.remote.exchange.ExchangeRemoteDataSource
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.data.mapper.exchange.toDomain
import com.cryptopulse.app.domain.models.*
import com.cryptopulse.app.domain.repository.ExchangeRepository
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ExchangeRepositoryImpl @Inject constructor(
    private val exchangeRemoteDataSource: ExchangeRemoteDataSource,
    private val exchangeConnectionManager: ExchangeConnectionManager,
    private val dispatcherProvider: DispatcherProvider
) : ExchangeRepository {

    private suspend fun handlePossibleAuthFailure(error: NetworkError) {
        if (error is NetworkError.HttpError) {
            val code = error.errorCode
            if (code in listOf("AUTHENTICATION_FAILED", "INVALID_API_KEY", "INVALID_SIGNATURE", "PERMISSION_DENIED", "INSUFFICIENT_PERMISSIONS", "READ_ONLY_API_KEY", "IP_NOT_WHITELISTED")) {
                exchangeConnectionManager.clearConnection()
            }
        }
    }

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
            is NetworkResult.Success -> {
                exchangeConnectionManager.saveConnection(exchangeName, environment)
                NetworkResult.Success(Unit)
            }
            is NetworkResult.Error -> result
        }
    }

    override suspend fun getConnectionStatus(): NetworkResult<ExchangeStatus> = withContext(dispatcherProvider.io) {
        when (val result = exchangeRemoteDataSource.getConnectionStatus()) {
            is NetworkResult.Success -> {
                val state = ExchangeStatus(
                    isConnected = result.data.isConnected,
                    exchangeName = result.data.exchangeName,
                    environment = result.data.environment,
                    region = result.data.region
                )
                if (!result.data.isConnected) {
                    exchangeConnectionManager.clearConnection()
                } else if (result.data.exchangeName != null && result.data.environment != null) {
                    exchangeConnectionManager.saveConnection(result.data.exchangeName, result.data.environment)
                }
                NetworkResult.Success(state)
            }
            is NetworkResult.Error -> {
                handlePossibleAuthFailure(result.error)
                result
            }
        }
    }

    override suspend fun getBalances(): NetworkResult<List<BalanceItem>> = withContext(dispatcherProvider.io) {
        when (val result = exchangeRemoteDataSource.getBalances()) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.balances?.map { it.toDomain() } ?: emptyList())
            is NetworkResult.Error -> {
                handlePossibleAuthFailure(result.error)
                result
            }
        }
    }
}


