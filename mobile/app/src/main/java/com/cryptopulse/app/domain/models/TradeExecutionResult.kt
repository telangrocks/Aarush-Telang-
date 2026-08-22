package com.cryptopulse.app.domain.models

data class TradeExecutionResult(
    val positionId: String,
    val alertId: String,
    val orderId: String,
    val symbol: String,
    val side: String,
    val strategy: String,
    val exchange: String,
    val environment: String,
    val orderType: String,
    val status: String,
    val entryStatus: String,
    val requestedEntryPrice: Double,
    val actualFillPrice: Double,
    val requestedQuantity: Double,
    val actualFilledQuantity: Double,
    val remainingQuantity: Double,
    val stopLoss: Double,
    val takeProfit: Double,
    val slippagePercent: Double,
    val submittedAt: String,
    val executedAt: String,
    val isFilled: Boolean,
    val isMockTrade: Boolean = false
)
