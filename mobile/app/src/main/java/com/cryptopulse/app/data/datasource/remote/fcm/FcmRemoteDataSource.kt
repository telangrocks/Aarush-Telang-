package com.cryptopulse.app.data.datasource.remote.fcm

import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.network.safeApiCall
import com.cryptopulse.app.data.api.FcmApi
import com.cryptopulse.app.data.api.dto.fcm.request.FcmRegisterRequestDto
import com.cryptopulse.app.data.api.dto.fcm.response.FcmRegisterResponseDto
import javax.inject.Inject

interface FcmRemoteDataSource {
    suspend fun registerToken(request: FcmRegisterRequestDto): NetworkResult<FcmRegisterResponseDto>
}

class RetrofitFcmRemoteDataSource @Inject constructor(
    private val fcmApi: FcmApi
) : FcmRemoteDataSource {
    override suspend fun registerToken(request: FcmRegisterRequestDto): NetworkResult<FcmRegisterResponseDto> =
        safeApiCall { fcmApi.registerToken(request) }
}
