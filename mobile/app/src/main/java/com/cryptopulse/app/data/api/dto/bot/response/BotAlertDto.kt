package com.cryptopulse.app.data.api.dto.bot.response

data class BotAlertDto(
    val id: String,
    val symbol: String,
    val entryPrice: Double,
    val stopLoss: Double,
    val takeProfit: Double,
    val estimatedPnl: Double? = null,
    val strategy: String?,
    val side: String?,
    val timestamp: String?,
    val signalPrice: Double? = null,
    val targetEntryPrice: Double? = null,
    val positionSize: Double? = null,
    val entryIntent: String? = null,
    val timeframe: String? = null,
    val quantity: Double? = null,
    val requestedBudget: Double? = null,
    val effectiveNotional: Double? = null,
    val isExecutable: Boolean? = null,
    val ineligibilityReason: String? = null,
    val approvalGeneration: Long? = null,
    val confidenceScore: Double? = null,
    val requiredScore: Double? = null
)
