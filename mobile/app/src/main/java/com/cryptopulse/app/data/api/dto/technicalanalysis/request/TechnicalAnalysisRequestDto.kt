package com.cryptopulse.app.data.api.dto.technicalanalysis.request

data class TechnicalAnalysisRequestDto(
    val symbol: String,
    val strategy: String,
    val config: Map<String, Any>? = null
)
