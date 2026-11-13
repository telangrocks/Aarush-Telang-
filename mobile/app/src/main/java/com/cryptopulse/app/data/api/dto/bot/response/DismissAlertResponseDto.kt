package com.cryptopulse.app.data.api.dto.bot.response

data class DismissAlertResponseDto(
    val success: Boolean,
    val message: String? = null,
    val alertId: String? = null,
    val status: String? = null
)
