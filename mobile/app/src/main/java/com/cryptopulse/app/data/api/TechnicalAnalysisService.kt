package com.cryptopulse.app.data.api

import com.cryptopulse.app.data.api.dto.technicalanalysis.request.TechnicalAnalysisRequestDto
import com.cryptopulse.app.data.api.dto.technicalanalysis.response.TechnicalAnalysisResponseDto
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

interface TechnicalAnalysisService {
    @POST(ApiConstants.MARKET_TECHNICAL_ANALYSIS)
    suspend fun getAnalysis(@Body request: TechnicalAnalysisRequestDto): Response<TechnicalAnalysisResponseDto>
}
