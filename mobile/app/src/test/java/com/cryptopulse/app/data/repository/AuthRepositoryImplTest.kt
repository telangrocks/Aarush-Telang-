package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.auth.request.LoginRequestDto
import com.cryptopulse.app.data.api.dto.auth.request.RefreshRequestDto
import com.cryptopulse.app.data.api.dto.auth.request.RegisterRequestDto
import com.cryptopulse.app.data.api.dto.auth.response.LoginResponseDto
import com.cryptopulse.app.data.api.dto.auth.response.LogoutResponseDto
import com.cryptopulse.app.data.api.dto.auth.response.RefreshResponseDto
import com.cryptopulse.app.data.api.dto.auth.response.RegisterResponseDto
import com.cryptopulse.app.data.datasource.remote.auth.AuthRemoteDataSource
import com.cryptopulse.app.data.local.TokenManager
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AuthRepositoryImplTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var dispatcherProvider: DispatcherProvider
    private lateinit var fakeRemoteDataSource: FakeAuthRemoteDataSource
    private lateinit var fakeTokenManager: FakeAuthTokenManager
    private lateinit var repository: AuthRepositoryImpl

    @Before
    fun setup() {
        dispatcherProvider = object : DispatcherProvider {
            override val main: CoroutineDispatcher = testDispatcher
            override val io: CoroutineDispatcher = testDispatcher
            override val default: CoroutineDispatcher = testDispatcher
            override val unconfined: CoroutineDispatcher = testDispatcher
        }
        fakeRemoteDataSource = FakeAuthRemoteDataSource()
        fakeTokenManager = FakeAuthTokenManager()
        repository = AuthRepositoryImpl(
            authRemoteDataSource = fakeRemoteDataSource,
            dispatcherProvider = dispatcherProvider,
            tokenManager = fakeTokenManager
        )
    }

    @Test
    fun `register with valid tokens should save tokens and return success`() = runTest {
        fakeRemoteDataSource.registerResult = NetworkResult.Success(
            RegisterResponseDto(
                message = "Account created",
                accessToken = "valid_access_token",
                refreshToken = "valid_refresh_token",
                error = null
            )
        )

        val result = repository.register("test@example.com", "Password@123", "Password@123")

        assertTrue(result is NetworkResult.Success)
        assertTrue(fakeTokenManager.saveTokensCalled)
        assertEquals("valid_access_token", fakeTokenManager.savedAccessToken)
        assertEquals("valid_refresh_token", fakeTokenManager.savedRefreshToken)
    }

    @Test
    fun `register with API error should not save tokens and return error`() = runTest {
        fakeRemoteDataSource.registerResult = NetworkResult.Error(
            NetworkError.HttpError(code = 409, message = "User already exists")
        )

        val result = repository.register("test@example.com", "Password@123", "Password@123")

        assertTrue(result is NetworkResult.Error)
        assertFalse(fakeTokenManager.saveTokensCalled)
        assertNull(fakeTokenManager.savedAccessToken)
        assertNull(fakeTokenManager.savedRefreshToken)
    }

    @Test
    fun `register with missing access token should not save tokens and return serialization error`() = runTest {
        fakeRemoteDataSource.registerResult = NetworkResult.Success(
            RegisterResponseDto(
                message = "Account created",
                accessToken = null,
                refreshToken = "valid_refresh_token",
                error = null
            )
        )

        val result = repository.register("test@example.com", "Password@123", "Password@123")

        assertTrue(result is NetworkResult.Error)
        assertEquals(NetworkError.Serialization, (result as NetworkResult.Error).error)
        assertFalse(fakeTokenManager.saveTokensCalled)
    }

    @Test
    fun `register with missing refresh token should not save tokens and return serialization error`() = runTest {
        fakeRemoteDataSource.registerResult = NetworkResult.Success(
            RegisterResponseDto(
                message = "Account created",
                accessToken = "valid_access_token",
                refreshToken = null,
                error = null
            )
        )

        val result = repository.register("test@example.com", "Password@123", "Password@123")

        assertTrue(result is NetworkResult.Error)
        assertEquals(NetworkError.Serialization, (result as NetworkResult.Error).error)
        assertFalse(fakeTokenManager.saveTokensCalled)
    }

    @Test
    fun `register with blank tokens should not save tokens and return serialization error`() = runTest {
        fakeRemoteDataSource.registerResult = NetworkResult.Success(
            RegisterResponseDto(
                message = "Account created",
                accessToken = "   ",
                refreshToken = "",
                error = null
            )
        )

        val result = repository.register("test@example.com", "Password@123", "Password@123")

        assertTrue(result is NetworkResult.Error)
        assertEquals(NetworkError.Serialization, (result as NetworkResult.Error).error)
        assertFalse(fakeTokenManager.saveTokensCalled)
    }

    @Test
    fun `login with valid tokens should save tokens and return success`() = runTest {
        fakeRemoteDataSource.loginResult = NetworkResult.Success(
            LoginResponseDto(
                accessToken = "login_access_token",
                refreshToken = "login_refresh_token",
                error = null
            )
        )

        val result = repository.login("test@example.com", "Password@123")

        assertTrue(result is NetworkResult.Success)
        assertTrue(fakeTokenManager.saveTokensCalled)
        assertEquals("login_access_token", fakeTokenManager.savedAccessToken)
        assertEquals("login_refresh_token", fakeTokenManager.savedRefreshToken)
    }

    @Test
    fun `login with missing token should not save tokens and return serialization error`() = runTest {
        fakeRemoteDataSource.loginResult = NetworkResult.Success(
            LoginResponseDto(
                accessToken = "",
                refreshToken = "login_refresh_token",
                error = null
            )
        )

        val result = repository.login("test@example.com", "Password@123")

        assertTrue(result is NetworkResult.Error)
        assertEquals(NetworkError.Serialization, (result as NetworkResult.Error).error)
        assertFalse(fakeTokenManager.saveTokensCalled)
    }

    @Test
    fun `refreshToken with valid refresh token saves new tokens and returns success`() = runTest {
        fakeTokenManager.savedRefreshToken = "valid_refresh_token"
        fakeTokenManager.savedAccessToken = "old_access_token"
        fakeRemoteDataSource.refreshTokenResult = NetworkResult.Success(
            RefreshResponseDto(
                accessToken = "new_access_token",
                refreshToken = "new_refresh_token",
                error = null
            )
        )

        val result = repository.refreshToken()

        assertTrue(result is NetworkResult.Success)
        assertEquals("valid_refresh_token", fakeRemoteDataSource.lastRefreshRequest?.refreshToken)
        assertEquals("new_access_token", fakeTokenManager.savedAccessToken)
        assertEquals("new_refresh_token", fakeTokenManager.savedRefreshToken)
    }

    @Test
    fun `refreshToken with missing refresh token returns error without calling API`() = runTest {
        fakeTokenManager.savedRefreshToken = null
        fakeTokenManager.savedAccessToken = "some_access_token"

        val result = repository.refreshToken()

        assertTrue(result is NetworkResult.Error)
        assertNull(fakeRemoteDataSource.lastRefreshRequest)
    }

    @Test
    fun `refreshToken with 401 fatal auth error clears tokens`() = runTest {
        fakeTokenManager.savedRefreshToken = "revoked_refresh_token"
        fakeTokenManager.savedAccessToken = "old_access_token"
        fakeRemoteDataSource.refreshTokenResult = NetworkResult.Error(
            NetworkError.HttpError(code = 401, message = "Invalid or expired refresh token")
        )

        val result = repository.refreshToken()

        assertTrue(result is NetworkResult.Error)
        assertNull(fakeTokenManager.savedAccessToken)
        assertNull(fakeTokenManager.savedRefreshToken)
    }

    @Test
    fun `refreshToken with IOException network error does NOT clear tokens`() = runTest {
        fakeTokenManager.savedRefreshToken = "valid_refresh_token"
        fakeTokenManager.savedAccessToken = "old_access_token"
        fakeRemoteDataSource.refreshTokenResult = NetworkResult.Error(
            NetworkError.Unknown(java.io.IOException("Socket timeout"))
        )

        val result = repository.refreshToken()

        assertTrue(result is NetworkResult.Error)
        assertEquals("old_access_token", fakeTokenManager.savedAccessToken)
        assertEquals("valid_refresh_token", fakeTokenManager.savedRefreshToken)
    }

    @Test
    fun `refreshToken with 500 server error does NOT clear tokens`() = runTest {
        fakeTokenManager.savedRefreshToken = "valid_refresh_token"
        fakeTokenManager.savedAccessToken = "old_access_token"
        fakeRemoteDataSource.refreshTokenResult = NetworkResult.Error(
            NetworkError.HttpError(code = 500, message = "Internal Server Error")
        )

        val result = repository.refreshToken()

        assertTrue(result is NetworkResult.Error)
        assertEquals("old_access_token", fakeTokenManager.savedAccessToken)
        assertEquals("valid_refresh_token", fakeTokenManager.savedRefreshToken)
    }
}

private class FakeAuthRemoteDataSource : AuthRemoteDataSource {
    var loginResult: NetworkResult<LoginResponseDto> = NetworkResult.Success(
        LoginResponseDto(accessToken = "default_access", refreshToken = "default_refresh", error = null)
    )
    var registerResult: NetworkResult<RegisterResponseDto> = NetworkResult.Success(
        RegisterResponseDto(message = "ok", accessToken = "default_access", refreshToken = "default_refresh", error = null)
    )
    var refreshTokenResult: NetworkResult<RefreshResponseDto> = NetworkResult.Success(
        RefreshResponseDto(accessToken = "new_access", refreshToken = "new_refresh", error = null)
    )
    var lastRefreshRequest: RefreshRequestDto? = null

    override suspend fun login(request: LoginRequestDto): NetworkResult<LoginResponseDto> = loginResult
    override suspend fun register(request: RegisterRequestDto): NetworkResult<RegisterResponseDto> = registerResult
    override suspend fun logout(): NetworkResult<LogoutResponseDto> = NetworkResult.Success(LogoutResponseDto(success = true, message = "ok"))
    override suspend fun refreshToken(request: RefreshRequestDto): NetworkResult<RefreshResponseDto> {
        lastRefreshRequest = request
        return refreshTokenResult
    }
}

private class FakeAuthTokenManager : TokenManager(FakeContextForAuthTest()) {
    var saveTokensCalled = false
    var savedAccessToken: String? = null
    var savedRefreshToken: String? = null

    override suspend fun saveTokens(accessToken: String, refreshToken: String) {
        saveTokensCalled = true
        savedAccessToken = accessToken
        savedRefreshToken = refreshToken
    }

    override suspend fun getToken(): String? = savedAccessToken
    override suspend fun getRefreshToken(): String? = savedRefreshToken
    override suspend fun clearTokens() {
        savedAccessToken = null
        savedRefreshToken = null
    }
}

private class FakeContextForAuthTest : android.content.ContextWrapper(null)
