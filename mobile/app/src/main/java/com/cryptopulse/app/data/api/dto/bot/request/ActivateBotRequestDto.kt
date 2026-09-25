package com.cryptopulse.app.data.api.dto.bot.request

data class ActivateBotRequestDto(
    val symbols: List<String>? = null,
    val coinId: String? = null,
    val strategy: String,
    val positionSize: Double? = null,
    val targetEntryPrice: Double? = null,
    val config: Map<String, Any>? = null,
    val entryIntent: String? = null
)
