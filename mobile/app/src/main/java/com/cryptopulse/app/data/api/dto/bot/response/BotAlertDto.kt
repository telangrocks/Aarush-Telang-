package com.cryptopulse.app.data.api.dto.bot.response

data class BotAlertDto(
    val id: String,
    val symbol: String,
    val entryPrice: Double,
    val stopLoss: Double,
    val takeProfit: Double,
    val estimatedPnl: Double,
    val strategy: String?,
    val side: String?,
    val timestamp: String?,
    val signalPrice: Double?,
    val targetEntryPrice: Double?
)
