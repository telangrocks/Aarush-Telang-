package com.cryptopulse.app.data.api.dto.bot.request

data class ActivateBotRequestDto(
    val coinId: String,
    val strategy: String,
    val positionSize: Double? = null,
    val targetEntryPrice: Double? = null,
    val config: Map<String, Any>? = null,
    val entryIntent: String? = null
)
