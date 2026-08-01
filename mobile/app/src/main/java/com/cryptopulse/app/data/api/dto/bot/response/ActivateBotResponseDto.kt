package com.cryptopulse.app.data.api.dto.bot.response

data class ActivateBotResponseDto(
    val success: Boolean,
    val message: String,
    val code: String? = null,
    val hint: String? = null
)
