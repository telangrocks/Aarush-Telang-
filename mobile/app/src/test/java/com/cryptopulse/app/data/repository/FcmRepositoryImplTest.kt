package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.fcm.request.FcmRegisterRequestDto
import com.cryptopulse.app.data.api.dto.fcm.response.FcmRegisterResponseDto
import com.cryptopulse.app.data.datasource.remote.fcm.FcmRemoteDataSource
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FcmRepositoryImplTest {

    private val testDispatcher = StandardTestDispatcher()
    private val testDispatcherProvider = object : DispatcherProvider {
        override val main: CoroutineDispatcher = testDispatcher
        override val io: CoroutineDispatcher = testDispatcher
        override val default: CoroutineDispatcher = testDispatcher
        override val unconfined: CoroutineDispatcher = testDispatcher
    }

    @Test
    fun `registerToken passes fcmToken in FcmRegisterRequestDto to remote data source`() = runTest(testDispatcher) {
        var capturedRequest: FcmRegisterRequestDto? = null

        val fakeRemoteDataSource = object : FcmRemoteDataSource {
            override suspend fun registerToken(request: FcmRegisterRequestDto): NetworkResult<FcmRegisterResponseDto> {
                capturedRequest = request
                return NetworkResult.Success(FcmRegisterResponseDto(success = true, message = "Registered"))
            }
        }

        val repository = FcmRepositoryImpl(fakeRemoteDataSource, testDispatcherProvider)
        val result = repository.registerToken("device_fcm_token_12345")

        assertTrue("Expected Success result", result is NetworkResult.Success)
        assertEquals("device_fcm_token_12345", capturedRequest?.fcmToken)
    }

    @Test
    fun `registerToken propagates error from remote data source`() = runTest(testDispatcher) {
        val expectedError = NetworkError.HttpError(500, "Network error")
        val fakeRemoteDataSource = object : FcmRemoteDataSource {
            override suspend fun registerToken(request: FcmRegisterRequestDto): NetworkResult<FcmRegisterResponseDto> {
                return NetworkResult.Error(expectedError)
            }
        }

        val repository = FcmRepositoryImpl(fakeRemoteDataSource, testDispatcherProvider)
        val result = repository.registerToken("device_fcm_token_error")

        assertTrue("Expected Error result", result is NetworkResult.Error)
        assertEquals(expectedError, (result as NetworkResult.Error).error)
    }
}
