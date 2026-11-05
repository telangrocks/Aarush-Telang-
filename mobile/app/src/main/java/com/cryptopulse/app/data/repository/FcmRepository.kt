package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.core.network.safeApiCall
import com.cryptopulse.app.data.api.dto.fcm.request.FcmRegisterRequestDto
import com.cryptopulse.app.data.datasource.remote.fcm.FcmRemoteDataSource
import com.cryptopulse.app.domain.repository.FcmRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class FcmRepositoryImpl @Inject constructor(
    private val fcmRemoteDataSource: FcmRemoteDataSource,
    private val dispatcherProvider: DispatcherProvider? = null,
) : FcmRepository {

    private val scope = CoroutineScope(SupervisorJob() + (dispatcherProvider?.io ?: Dispatchers.IO))
    private val mutex = Mutex()
    private var lastRegisteredToken: String? = null
    private var inFlightToken: String? = null
    private var inFlightDeferred: Deferred<NetworkResult<Unit>>? = null
    private var sessionGeneration: Long = 0L

    override suspend fun registerToken(token: String): NetworkResult<Unit> {
        val cleanToken = token.trim()
        if (cleanToken.isBlank()) return NetworkResult.Error(NetworkError.Unknown(Exception("FCM token is blank")))

        val deferred = mutex.withLock {
            if (cleanToken == lastRegisteredToken) {
                return NetworkResult.Success(Unit) // already registered this session
            }
            if (inFlightDeferred != null && inFlightToken == cleanToken) {
                inFlightDeferred!! // coalesce into the existing in-flight request
            } else {
                val capturedGeneration = sessionGeneration
                val d = scope.async {
                    try {
                        val result: NetworkResult<Unit> = when (val r = fcmRemoteDataSource.registerToken(FcmRegisterRequestDto(fcmToken = cleanToken))) {
                            is NetworkResult.Success -> NetworkResult.Success(Unit)
                            is NetworkResult.Error -> r
                        }
                        mutex.withLock {
                            if (sessionGeneration == capturedGeneration && result is NetworkResult.Success) {
                                lastRegisteredToken = cleanToken
                            }
                            if (inFlightToken == cleanToken) {
                                inFlightToken = null
                                inFlightDeferred = null
                            }
                        }
                        result
                    } catch (e: Exception) {
                        mutex.withLock {
                            if (inFlightToken == cleanToken) {
                                inFlightToken = null
                                inFlightDeferred = null
                            }
                        }
                        NetworkResult.Error(NetworkError.Unknown(e))
                    }
                }
                inFlightToken = cleanToken
                inFlightDeferred = d
                d
            }
        }
        return deferred.await()
    }

    override fun clearRegistrationState() {
        scope.launch {
            mutex.withLock {
                sessionGeneration++
                lastRegisteredToken = null
                inFlightDeferred?.cancel()
                inFlightDeferred = null
                inFlightToken = null
            }
        }
    }
}
