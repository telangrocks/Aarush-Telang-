package com.cryptopulse.app.data.api.dto.bot.response

data class ExecuteTradeResponseDto(
    val success: Boolean,
    val message: String,
    val positionId: String? = null,
    val alertId: String? = null,
    val orderId: String? = null,
    val executionPrice: Double? = null,
    val side: String? = null,
    val symbol: String? = null,
    val isMockTrade: Boolean? = false,
    val quantity: Double? = null,
    val stopLoss: Double? = null,
    val takeProfit: Double? = null,
    val executedAt: String? = null
)
