package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.technicalanalysis.request.TechnicalAnalysisRequestDto
import com.cryptopulse.app.data.datasource.remote.technicalanalysis.TechnicalAnalysisRemoteDataSource
import com.cryptopulse.app.data.mapper.technicalanalysis.toDomain
import com.cryptopulse.app.data.mapper.technicalanalysis.toAnalysisSnapshot
import com.cryptopulse.app.domain.models.TechnicalAnalysisResult
import com.cryptopulse.app.domain.models.AnalysisSnapshot
import com.cryptopulse.app.domain.repository.TechnicalAnalysisRepository
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TechnicalAnalysisRepositoryImpl @Inject constructor(
    private val technicalAnalysisRemoteDataSource: TechnicalAnalysisRemoteDataSource,
    private val dispatcherProvider: DispatcherProvider
) : TechnicalAnalysisRepository {

    override suspend fun getAnalysis(symbol: String, strategy: String, config: com.cryptopulse.app.domain.models.TradeSetupConfig?): NetworkResult<TechnicalAnalysisResult> = withContext(dispatcherProvider.io) {
        val request = TechnicalAnalysisRequestDto(symbol, strategy, config?.let { com.google.gson.Gson().fromJson(com.google.gson.Gson().toJson(it), Map::class.java) as Map<String, Any> })
        when (val result = technicalAnalysisRemoteDataSource.getAnalysis(request)) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.toDomain())
            is NetworkResult.Error -> result
        }
    }

    override suspend fun getAnalysisSnapshot(symbol: String, strategy: String, config: com.cryptopulse.app.domain.models.TradeSetupConfig?): NetworkResult<AnalysisSnapshot> = withContext(dispatcherProvider.io) {
        val request = TechnicalAnalysisRequestDto(symbol, strategy, config?.let { com.google.gson.Gson().fromJson(com.google.gson.Gson().toJson(it), Map::class.java) as Map<String, Any> })
        when (val result = technicalAnalysisRemoteDataSource.getAnalysis(request)) {
            is NetworkResult.Success -> NetworkResult.Success(result.data.toAnalysisSnapshot())
            is NetworkResult.Error -> result
        }
    }
}
