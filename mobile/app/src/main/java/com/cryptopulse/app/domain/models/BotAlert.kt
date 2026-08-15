package com.cryptopulse.app.domain.models

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
    val positionSize: Double? = null,
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
            positionSize = (map["positionSize"] as? Number)?.toDouble(),
        )
    }
}
