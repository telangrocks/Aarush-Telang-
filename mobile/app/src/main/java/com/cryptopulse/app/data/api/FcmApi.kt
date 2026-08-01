package com.cryptopulse.app.data.api

import com.cryptopulse.app.data.api.dto.fcm.request.*
import com.cryptopulse.app.data.api.dto.fcm.response.*
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

interface FcmApi {
    @POST(ApiConstants.FCM_REGISTER)
    suspend fun registerToken(@Body request: FcmRegisterRequestDto): Response<FcmRegisterResponseDto>
}
