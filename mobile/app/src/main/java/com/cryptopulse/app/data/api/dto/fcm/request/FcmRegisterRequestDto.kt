package com.cryptopulse.app.data.api.dto.fcm.request

import com.google.gson.annotations.SerializedName

data class FcmRegisterRequestDto(
    @SerializedName("fcmToken")
    val fcmToken: String
)
