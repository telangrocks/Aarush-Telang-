package com.cryptopulse.app.domain.repository

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*

interface ExchangeRepository {
    suspend fun validateKeys(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String = "mainnet"): NetworkResult<Unit>
    suspend fun connectExchange(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String = "mainnet"): NetworkResult<Unit>
    suspend fun getConnectionStatus(): NetworkResult<ExchangeStatus>
    suspend fun getBalances(): NetworkResult<List<BalanceItem>>
}

