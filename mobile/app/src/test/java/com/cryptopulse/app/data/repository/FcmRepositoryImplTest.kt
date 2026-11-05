package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.fcm.request.FcmRegisterRequestDto
import com.cryptopulse.app.data.api.dto.fcm.response.FcmRegisterResponseDto
import com.cryptopulse.app.data.datasource.remote.fcm.FcmRemoteDataSource
import kotlinx.coroutines.async
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

    @Test
    fun `registerToken deduplicates repeated calls with identical token during same session`() = runTest(testDispatcher) {
        var callCount = 0
        val fakeRemoteDataSource = object : FcmRemoteDataSource {
            override suspend fun registerToken(request: FcmRegisterRequestDto): NetworkResult<FcmRegisterResponseDto> {
                callCount++
                return NetworkResult.Success(FcmRegisterResponseDto(success = true, message = "Registered"))
            }
        }

        val repository = FcmRepositoryImpl(fakeRemoteDataSource, testDispatcherProvider)
        val res1 = repository.registerToken("same_token")
        val res2 = repository.registerToken("same_token")

        assertTrue(res1 is NetworkResult.Success)
        assertTrue(res2 is NetworkResult.Success)
        assertEquals("Expected only 1 remote call for identical token", 1, callCount)
    }

    @Test
    fun `clearRegistrationState allows re-registration after logout`() = runTest(testDispatcher) {
        var callCount = 0
        val fakeRemoteDataSource = object : FcmRemoteDataSource {
            override suspend fun registerToken(request: FcmRegisterRequestDto): NetworkResult<FcmRegisterResponseDto> {
                callCount++
                return NetworkResult.Success(FcmRegisterResponseDto(success = true, message = "Registered"))
            }
        }

        val repository = FcmRepositoryImpl(fakeRemoteDataSource, testDispatcherProvider)
        repository.registerToken("re_reg_token")
        assertEquals(1, callCount)

        repository.clearRegistrationState()
        testScheduler.advanceUntilIdle()

        repository.registerToken("re_reg_token")
        assertEquals("Expected 2 remote calls after clearRegistrationState", 2, callCount)
    }

    @Test
    fun `failed registration remains retryable on subsequent attempts`() = runTest(testDispatcher) {
        var callCount = 0
        val fakeRemoteDataSource = object : FcmRemoteDataSource {
            override suspend fun registerToken(request: FcmRegisterRequestDto): NetworkResult<FcmRegisterResponseDto> {
                callCount++
                return if (callCount == 1) {
                    NetworkResult.Error(NetworkError.HttpError(500, "Server Error"))
                } else {
                    NetworkResult.Success(FcmRegisterResponseDto(success = true, message = "Success"))
                }
            }
        }

        val repository = FcmRepositoryImpl(fakeRemoteDataSource, testDispatcherProvider)
        val res1 = repository.registerToken("retry_token")
        assertTrue(res1 is NetworkResult.Error)
        assertEquals(1, callCount)

        val res2 = repository.registerToken("retry_token")
        assertTrue(res2 is NetworkResult.Success)
        assertEquals(2, callCount)
    }

    @Test
    fun `concurrent registerToken calls for same token are coalesced into a single remote call`() = runTest(testDispatcher) {
        var callCount = 0
        val fakeRemoteDataSource = object : FcmRemoteDataSource {
            override suspend fun registerToken(request: FcmRegisterRequestDto): NetworkResult<FcmRegisterResponseDto> {
                callCount++
                kotlinx.coroutines.delay(50)
                return NetworkResult.Success(FcmRegisterResponseDto(success = true, message = "Success"))
            }
        }

        val repository = FcmRepositoryImpl(fakeRemoteDataSource, testDispatcherProvider)
        val d1 = async { repository.registerToken("concurrent_token") }
        val d2 = async { repository.registerToken("concurrent_token") }

        val r1 = d1.await()
        val r2 = d2.await()

        assertTrue(r1 is NetworkResult.Success<*>)
        assertTrue(r2 is NetworkResult.Success<*>)
        assertEquals("Expected exactly 1 remote call for coalesced requests", 1, callCount)
    }

    @Test
    fun `token rotation triggers new remote registration and updates registered token`() = runTest(testDispatcher) {
        val registeredTokens = mutableListOf<String>()
        val fakeRemoteDataSource = object : FcmRemoteDataSource {
            override suspend fun registerToken(request: FcmRegisterRequestDto): NetworkResult<FcmRegisterResponseDto> {
                registeredTokens.add(request.fcmToken)
                return NetworkResult.Success(FcmRegisterResponseDto(success = true, message = "Success"))
            }
        }

        val repository = FcmRepositoryImpl(fakeRemoteDataSource, testDispatcherProvider)
        repository.registerToken("token_v1")
        assertEquals(listOf("token_v1"), registeredTokens)

        // Rotate to token_v2
        repository.registerToken("token_v2")
        assertEquals(listOf("token_v1", "token_v2"), registeredTokens)

        // Repeat token_v2 should be deduplicated
        repository.registerToken("token_v2")
        assertEquals(listOf("token_v1", "token_v2"), registeredTokens)
    }
}
