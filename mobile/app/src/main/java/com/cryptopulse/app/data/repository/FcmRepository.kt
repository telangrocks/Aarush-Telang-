package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.fcm.request.FcmRegisterRequestDto
import com.cryptopulse.app.data.datasource.remote.fcm.FcmRemoteDataSource
import com.cryptopulse.app.domain.repository.FcmRepository
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class FcmRepositoryImpl @Inject constructor(
    private val fcmRemoteDataSource: FcmRemoteDataSource,
    private val dispatcherProvider: DispatcherProvider
) : FcmRepository {
    override suspend fun registerToken(token: String): NetworkResult<Unit> = withContext(dispatcherProvider.io) {
        when (val result = fcmRemoteDataSource.registerToken(FcmRegisterRequestDto(token))) {
            is NetworkResult.Success -> NetworkResult.Success(Unit)
            is NetworkResult.Error -> result
        }
    }
}
