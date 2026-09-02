package com.cryptopulse.app.domain.repository

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.Strategy

interface StrategyRepository {
    suspend fun getStrategies(): NetworkResult<List<Strategy>>
    suspend fun getStrategyById(id: String): NetworkResult<Strategy?>
    fun clearCache()
}
