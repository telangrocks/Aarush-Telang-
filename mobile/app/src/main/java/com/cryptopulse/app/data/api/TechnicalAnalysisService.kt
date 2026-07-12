package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

data class TechnicalAnalysisRequest(
    val symbol: String,
    val strategy: String,
)

data class TechnicalAnalysisResponse(
    val symbol: String,
    val strategy: String,
    val price: Double,
    val change24h: Double,
    val volume: Double,
    val high24h: Double,
    val low24h: Double,
    val indicators: Map<String, Any>,
    val signals: Map<String, Any>,
    val timestamp: String,
)

interface TechnicalAnalysisService {
    @POST("/api/market/technical-analysis")
    suspend fun getAnalysis(@Body request: TechnicalAnalysisRequest): Response<TechnicalAnalysisResponse>
}
