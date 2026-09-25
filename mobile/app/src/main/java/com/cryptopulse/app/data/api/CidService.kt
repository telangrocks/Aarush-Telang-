package com.cryptopulse.app.data.api

import com.cryptopulse.app.data.api.dto.cid.CidPostEventsRequestDto
import com.cryptopulse.app.data.api.dto.cid.CidPostEventsResponseDto
import com.cryptopulse.app.data.api.dto.cid.CidStartSessionRequestDto
import com.cryptopulse.app.data.api.dto.cid.CidStartSessionResponseDto
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

interface CidService {
    @POST("api/cid/session/start")
    suspend fun startSession(
        @Body body: CidStartSessionRequestDto
    ): Response<CidStartSessionResponseDto>

    @POST("api/cid/events")
    suspend fun postEvents(
        @Body body: CidPostEventsRequestDto
    ): Response<CidPostEventsResponseDto>
}
