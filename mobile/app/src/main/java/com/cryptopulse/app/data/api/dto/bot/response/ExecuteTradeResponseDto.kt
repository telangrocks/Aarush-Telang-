package com.cryptopulse.app.data.api.dto.bot.response

data class ExecuteTradeResponseDto(
    val success: Boolean,
    val message: String,
    val orderId: String? = null,
    val executionPrice: Double? = null
)
