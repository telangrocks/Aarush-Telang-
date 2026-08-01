package com.cryptopulse.app.data.api.dto.bot.response

data class BotStatusResponseDto(
    val isActive: Boolean,
    val coinId: String?,
    val strategy: String?,
)
