package com.cryptopulse.app.domain.repository

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.domain.models.*

interface TechnicalAnalysisRepository {
    suspend fun getAnalysis(symbol: String, strategy: String, config: com.cryptopulse.app.domain.models.TradeSetupConfig?): NetworkResult<TechnicalAnalysisResult>
    suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: com.cryptopulse.app.domain.models.TradeSetupConfig?): NetworkResult<AnalysisSnapshot>
}
