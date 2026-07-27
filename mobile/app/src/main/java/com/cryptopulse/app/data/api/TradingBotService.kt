package com.cryptopulse.app.data.api

import com.google.gson.annotations.SerializedName
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

data class ActivateBotRequest(
    val coinId: String,
    val strategy: String,
    val positionSize: Double? = null,
    val targetEntryPrice: Double? = null,
    val config: Map<String, Any>? = null
)

data class ActivateBotResponse(
    val success: Boolean,
    val message: String,
    val code: String? = null,
    val hint: String? = null
)

data class BotStatusResponse(
    val isActive: Boolean,
    val coinId: String?,
    val strategy: String?,
)

data class AnalysisLog(
    val timestamp: String,
    val level: String,
    val message: String,
)

data class ScanCandidate(
    val symbol: String,
    val price: Double,
    val progress: Int,
    val status: String,
)

data class NearMatch(
    val symbol: String,
    val confidence: Int,
    val estimatedEntry: Double,
    val currentPrice: Double,
    val conditionsMet: List<String>,
)

data class Checkpoint(
    val name: String,
    val status: String,
)

data class TimeframeAnalysis(
    val timeframe: String,
    val interval: String,
    val trend: String,
    val momentum: String,
    val volumeProfile: String,
    val emaCross: String,
    val rsi: Double,
    val confidence: Int,
    val reasoning: List<String>,
)

data class AnalysisStatusResponse(
    val isActive: Boolean,
    val strategy: String?,
    val coinId: String?,
    val exchange: String? = null,
    val environment: String? = null,
    val scanningProgress: Int,
    val etaSeconds: Int,
    val confluenceScore: Int,
    val alignment: String,
    val primarySignal: String,
    val timeframes: List<TimeframeAnalysis>,
    val coinsCurrentlyScanning: List<ScanCandidate>,
    val nearMatches: List<NearMatch>,
    val checkpoints: List<Checkpoint>,
    val logs: List<AnalysisLog>,
    val opportunityDetected: Boolean,
)

data class BotAlert(
    val id: String,
    val symbol: String,
    val entryPrice: Double,
    val stopLoss: Double,
    val takeProfit: Double,
    val estimatedPnl: Double,
    val strategy: String?,
    val side: String?,
    val timestamp: String?,
    val signalPrice: Double? = null,
    val targetEntryPrice: Double? = null,
) {
    companion object {
        fun fromMap(map: Map<String, Any>): BotAlert = BotAlert(
            id = (map["id"] as? String) ?: "",
            symbol = (map["symbol"] as? String) ?: "UNKNOWN",
            entryPrice = (map["entryPrice"] as? Number)?.toDouble() ?: 0.0,
            stopLoss = (map["stopLoss"] as? Number)?.toDouble() ?: 0.0,
            takeProfit = (map["takeProfit"] as? Number)?.toDouble() ?: 0.0,
            estimatedPnl = (map["estimatedPnl"] as? Number)?.toDouble() ?: 0.0,
            strategy = map["strategy"] as? String,
            side = map["side"] as? String,
            timestamp = map["timestamp"] as? String,
            signalPrice = (map["signalPrice"] as? Number)?.toDouble() ?: (map["entryPrice"] as? Number)?.toDouble(),
            targetEntryPrice = (map["targetEntryPrice"] as? Number)?.toDouble(),
        )
    }
}



interface TradingBotService {
    @POST("/api/trading-bot/activate")
    suspend fun activate(@Body request: ActivateBotRequest): Response<ActivateBotResponse>

    @POST("/api/trading-bot/deactivate")
    suspend fun deactivate(): Response<ActivateBotResponse>

    @GET("/api/trading-bot/status")
    suspend fun getStatus(): Response<BotStatusResponse>

    @GET("/api/trading-bot/analysis-status")
    suspend fun getAnalysisStatus(): Response<com.cryptopulse.app.domain.models.AnalysisSnapshot>

    @POST("/api/trading-bot/execute-trade")
    suspend fun executeTrade(): Response<Map<String, Any>>

    @POST("/api/trading-bot/stop-trade")
    suspend fun stopTrade(): Response<Map<String, Any>>

    @GET("/api/trading-bot/alerts")
    suspend fun getAlerts(): Response<List<Map<String, Any>>>

    @POST("/api/trading-bot/alerts/acknowledge")
    suspend fun acknowledgeAlert(@Body request: Map<String, String>): Response<Map<String, Any>>


}
