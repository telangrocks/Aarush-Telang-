package com.cryptopulse.app.data.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.Headers
import retrofit2.http.POST

interface FcmApi {
    @POST("/api/fcm/register")
    @Headers("Content-Type: application/json")
    suspend fun registerToken(
        @Body request: Map<String, String>
    ): Response<Map<String, Any>>
}
