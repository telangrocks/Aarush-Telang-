package com.cryptopulse.app.data.datasource.remote.strategy

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.network.safeApiCall
import com.cryptopulse.app.data.api.StrategyApi
import com.cryptopulse.app.data.api.dto.strategy.response.StrategyDiscoveryResponseDto
import javax.inject.Inject

interface StrategyRemoteDataSource {
    suspend fun getAvailableStrategies(): NetworkResult<StrategyDiscoveryResponseDto>
}

class RetrofitStrategyRemoteDataSource @Inject constructor(
    private val strategyApi: StrategyApi
) : StrategyRemoteDataSource {
    override suspend fun getAvailableStrategies(): NetworkResult<StrategyDiscoveryResponseDto> =
        safeApiCall { strategyApi.getAvailableStrategies() }
}
