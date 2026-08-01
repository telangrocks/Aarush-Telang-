package com.cryptopulse.app.data.api.dto.bot.response

data class StopTradeResponseDto(
    val success: Boolean,
    val message: String,
    val realizedPnl: Double? = null
)
