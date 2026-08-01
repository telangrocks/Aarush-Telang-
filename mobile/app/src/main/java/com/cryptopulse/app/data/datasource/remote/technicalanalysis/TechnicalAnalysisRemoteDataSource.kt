package com.cryptopulse.app.data.datasource.remote.technicalanalysis

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.network.safeApiCall
import com.cryptopulse.app.data.api.TechnicalAnalysisService
import com.cryptopulse.app.data.api.dto.technicalanalysis.request.TechnicalAnalysisRequestDto
import com.cryptopulse.app.data.api.dto.technicalanalysis.response.TechnicalAnalysisResponseDto
import javax.inject.Inject

interface TechnicalAnalysisRemoteDataSource {
    suspend fun getAnalysis(request: TechnicalAnalysisRequestDto): NetworkResult<TechnicalAnalysisResponseDto>
}

class RetrofitTechnicalAnalysisRemoteDataSource @Inject constructor(
    private val technicalAnalysisService: TechnicalAnalysisService
) : TechnicalAnalysisRemoteDataSource {
    override suspend fun getAnalysis(request: TechnicalAnalysisRequestDto): NetworkResult<TechnicalAnalysisResponseDto> =
        safeApiCall { technicalAnalysisService.getAnalysis(request) }
}
