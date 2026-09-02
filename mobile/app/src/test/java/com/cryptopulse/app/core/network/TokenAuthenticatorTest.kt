package com.cryptopulse.app.core.network

import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.di.AppModule
import com.cryptopulse.app.domain.repository.AuthRepository
import dagger.Lazy
import kotlinx.coroutines.test.runTest
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class TokenAuthenticatorTest {

    private lateinit var fakeTokenManager: FakeAuthTokenManagerForAuthenticator
    private lateinit var fakeAuthRepository: FakeAuthRepositoryForAuthenticator
    private lateinit var authenticator: AppModule.TokenAuthenticator

    @Before
    fun setup() {
        fakeTokenManager = FakeAuthTokenManagerForAuthenticator()
        fakeAuthRepository = FakeAuthRepositoryForAuthenticator(fakeTokenManager)
        val lazyRepo = Lazy<AuthRepository> { fakeAuthRepository }
        authenticator = AppModule.TokenAuthenticator(fakeTokenManager, lazyRepo)
    }

    @Test
    fun `authenticate on public auth endpoint returns null to prevent infinite loop`() {
        val request = Request.Builder().url("https://api.test.com/api/refresh").build()
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(401)
            .message("Unauthorized")
            .build()

        val retryRequest = authenticator.authenticate(null, response)
        assertNull(retryRequest)
        assertEquals(0, fakeAuthRepository.refreshCount.get())
    }

    @Test
    fun `authenticate with expired access token successfully refreshes and attaches new Bearer token`() {
        fakeTokenManager.savedAccessToken = "expired_access_token"
        fakeTokenManager.savedRefreshToken = "valid_refresh_token"

        val request = Request.Builder()
            .url("https://api.test.com/api/market/candidates")
            .header("Authorization", "Bearer expired_access_token")
            .build()

        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(401)
            .message("Unauthorized")
            .build()

        val retryRequest = authenticator.authenticate(null, response)
        assertNotNull(retryRequest)
        assertEquals("Bearer new_rotated_access_token", retryRequest?.header("Authorization"))
        assertEquals(1, fakeAuthRepository.refreshCount.get())
    }

    @Test
    fun `concurrent 401 requests reuse newly refreshed token without duplicate refresh calls`() {
        fakeTokenManager.savedAccessToken = "expired_access_token"
        fakeTokenManager.savedRefreshToken = "valid_refresh_token"

        val request1 = Request.Builder()
            .url("https://api.test.com/api/market/candidates")
            .header("Authorization", "Bearer expired_access_token")
            .build()
        val response1 = Response.Builder()
            .request(request1)
            .protocol(Protocol.HTTP_1_1)
            .code(401)
            .message("Unauthorized")
            .build()

        val request2 = Request.Builder()
            .url("https://api.test.com/api/trading-bot/analysis-status")
            .header("Authorization", "Bearer expired_access_token")
            .build()
        val response2 = Response.Builder()
            .request(request2)
            .protocol(Protocol.HTTP_1_1)
            .code(401)
            .message("Unauthorized")
            .build()

        // First request executes refresh
        val retry1 = authenticator.authenticate(null, response1)
        assertNotNull(retry1)
        assertEquals("Bearer new_rotated_access_token", retry1?.header("Authorization"))
        assertEquals(1, fakeAuthRepository.refreshCount.get())

        // Second request with same failed token reuses newly refreshed token without calling refresh again!
        val retry2 = authenticator.authenticate(null, response2)
        assertNotNull(retry2)
        assertEquals("Bearer new_rotated_access_token", retry2?.header("Authorization"))
        assertEquals(1, fakeAuthRepository.refreshCount.get()) // MUST STILL BE 1
    }

    @Test
    fun `authenticate with failed refresh returns null`() {
        fakeTokenManager.savedAccessToken = "expired_access_token"
        fakeTokenManager.savedRefreshToken = "revoked_refresh_token"
        fakeAuthRepository.shouldSucceed = false

        val request = Request.Builder()
            .url("https://api.test.com/api/market/candidates")
            .header("Authorization", "Bearer expired_access_token")
            .build()

        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(401)
            .message("Unauthorized")
            .build()

        val retryRequest = authenticator.authenticate(null, response)
        assertNull(retryRequest)
        assertEquals(1, fakeAuthRepository.refreshCount.get())
    }
}

private class FakeAuthTokenManagerForAuthenticator : TokenManager(FakeContextForAuthenticator()) {
    var savedAccessToken: String? = null
    var savedRefreshToken: String? = null

    override suspend fun getToken(): String? = savedAccessToken
    override suspend fun getRefreshToken(): String? = savedRefreshToken
    override suspend fun saveTokens(accessToken: String, refreshToken: String) {
        savedAccessToken = accessToken
        savedRefreshToken = refreshToken
    }
    override suspend fun clearTokens() {
        savedAccessToken = null
        savedRefreshToken = null
    }
}

private class FakeAuthRepositoryForAuthenticator(
    private val tokenManager: FakeAuthTokenManagerForAuthenticator
) : AuthRepository {
    val refreshCount = AtomicInteger(0)
    var shouldSucceed = true

    override suspend fun login(email: String, password: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun register(email: String, password: String, confirm: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
    override suspend fun logout(): NetworkResult<Unit> = NetworkResult.Success(Unit)

    override suspend fun refreshToken(): NetworkResult<Unit> {
        refreshCount.incrementAndGet()
        return if (shouldSucceed) {
            tokenManager.savedAccessToken = "new_rotated_access_token"
            tokenManager.savedRefreshToken = "new_rotated_refresh_token"
            NetworkResult.Success(Unit)
        } else {
            tokenManager.clearTokens()
            NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(401, "Invalid refresh token"))
        }
    }
}

private class FakeContextForAuthenticator : android.content.ContextWrapper(null)
