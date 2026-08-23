package com.cryptopulse.app.data.api.dto.bot.request

import com.google.gson.annotations.SerializedName

data class ExecuteTradeRequestDto(
    @SerializedName("alertId") val alertId: String,
    @SerializedName("symbol") val symbol: String? = null,
    @SerializedName("side") val side: String? = null,
    @SerializedName("orderType") val orderType: String? = "MARKET",
    @SerializedName("targetEntryPrice") val targetEntryPrice: Double? = null,
    @SerializedName("signalPrice") val signalPrice: Double? = null,
    @SerializedName("stopLoss") val stopLoss: Double? = null,
    @SerializedName("takeProfit") val takeProfit: Double? = null,
    @SerializedName("positionSizeUsdt") val positionSizeUsdt: Double? = null,
    @SerializedName("strategy") val strategy: String? = null,
    @SerializedName("isMockTrade") val isMockTrade: Boolean = false
)

