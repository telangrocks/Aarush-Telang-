package com.cryptopulse.app.data.local

import android.content.Context
import android.content.ContextWrapper
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
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
import com.cryptopulse.app.data.repository.AuthRepositoryImpl
import com.cryptopulse.app.domain.repository.ExchangeRepository
import com.cryptopulse.app.domain.models.ExchangeStatus
import com.cryptopulse.app.domain.models.BalanceItem
import com.cryptopulse.app.ui.auth.AuthViewModel
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class TokenManagerDataStoreTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var encryptionManager: TokenEncryptionManager
    private lateinit var testDataStore: DataStore<Preferences>
    private lateinit var tokenManager: TokenManager

    private class TestContext : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this
    }

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        encryptionManager = TokenEncryptionManager(keyAlias = "test_crypto_key")
        val dataStoreFile = tempFolder.newFile("test_secure_tokens.preferences_pb")
        testDataStore = PreferenceDataStoreFactory.create(
            produceFile = { dataStoreFile }
        )
        tokenManager = TokenManager(
            context = TestContext(),
            customDataStore = testDataStore,
            customEncryptionManager = encryptionManager
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // -------------------------------------------------------------
    // 1. Encryption & Decryption Tests
    // -------------------------------------------------------------

    @Test
    fun `TokenEncryptionManager encrypts plaintext and decrypts to original`() {
        val originalToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        val encrypted = encryptionManager.encrypt(originalToken)

        assertNotNull(encrypted)
        assertTrue(encrypted.isNotBlank())
        assertNotEquals("Ciphertext must not match plaintext", originalToken, encrypted)

        val decrypted = encryptionManager.decrypt(encrypted)
        assertEquals("Decrypted token must exactly match original", originalToken, decrypted)
    }

    @Test
    fun `TokenEncryptionManager handles corrupted ciphertext safely without crashing`() {
        val corrupted1 = "ThisIsNotValidBase64@@@"
        val result1 = encryptionManager.decrypt(corrupted1)
        assertNull("Invalid Base64 must return null without crashing", result1)

        val corrupted2 = "AAAA" // Valid base64, but too short for 12-byte IV + tag
        val result2 = encryptionManager.decrypt(corrupted2)
        assertNull("Short payload must return null without crashing", result2)

        val result3 = encryptionManager.decrypt("")
        assertNull("Blank ciphertext must return null", result3)
    }

    @Test
    fun `TokenEncryptionManager key recovery allows fresh encryption after deleteKey`() {
        val token = "sample_access_token_for_recovery_test"
        val enc1 = encryptionManager.encrypt(token)
        assertEquals(token, encryptionManager.decrypt(enc1))

        // Simulate key deletion / rotation
        encryptionManager.deleteKey()

        val enc2 = encryptionManager.encrypt(token)
        val dec2 = encryptionManager.decrypt(enc2)
        assertEquals("Fresh encryption after key deletion must succeed", token, dec2)
    }

    // -------------------------------------------------------------
    // 2. Token Persistence & Retrieval via DataStore
    // -------------------------------------------------------------

    @Test
    fun `saveTokens persists access and refresh tokens and updates StateFlows`() = runTest {
        val accessToken = "access_jwt_12345"
        val refreshToken = "refresh_jwt_67890"

        tokenManager.saveTokens(accessToken, refreshToken)

        assertEquals(accessToken, tokenManager.getToken())
        assertEquals(refreshToken, tokenManager.getRefreshToken())

        val tokenState = tokenManager.tokenFlow.value
        assertTrue("Token flow must be Authenticated", tokenState is TokenState.Authenticated)
        assertEquals(accessToken, (tokenState as TokenState.Authenticated).token)

        val refreshState = tokenManager.refreshTokenFlow.value
        assertTrue("Refresh token flow must be Authenticated", refreshState is TokenState.Authenticated)
        assertEquals(refreshToken, (refreshState as TokenState.Authenticated).token)

        assertTrue("hasCachedTokenSync must return true", tokenManager.hasCachedTokenSync())
    }

    @Test
    fun `clearTokens resets tokens and transitions StateFlows to Unauthenticated`() = runTest {
        tokenManager.saveTokens("token_to_clear", "refresh_to_clear")
        assertTrue(tokenManager.hasCachedTokenSync())

        tokenManager.clearTokens()

        assertNull("getToken must be null after clear", tokenManager.getToken())
        assertNull("getRefreshToken must be null after clear", tokenManager.getRefreshToken())
        assertTrue("Token flow must be Unauthenticated", tokenManager.tokenFlow.value is TokenState.Unauthenticated)
        assertTrue("Refresh flow must be Unauthenticated", tokenManager.refreshTokenFlow.value is TokenState.Unauthenticated)
        assertFalse("hasCachedTokenSync must return false", tokenManager.hasCachedTokenSync())
    }

    @Test
    fun `markRegistrationCompleted persists state and updates fast sync accessor`() = runTest {
        assertFalse(tokenManager.isRegistrationCompletedSync())

        tokenManager.markRegistrationCompleted()

        assertTrue(tokenManager.isRegistrationCompleted())
        assertTrue(tokenManager.isRegistrationCompletedSync())
        assertTrue(tokenManager.isRegistrationCompletedFlow.value)
    }

    @Test
    fun `saveFcmToken and getFcmToken persist and retrieve cleanly`() = runTest {
        val fcm = "fcm_device_token_xyz"
        tokenManager.saveFcmToken(fcm)

        assertEquals(fcm, tokenManager.getFcmToken())
        assertEquals(fcm, tokenManager.fcmTokenFlow.value)
    }

    // -------------------------------------------------------------
    // 3. Corrupted Data Recovery (No Crashes on Android 16 / Realme)
    // -------------------------------------------------------------

    @Test
    fun `Corrupted encrypted token in DataStore safely resets to Unauthenticated without crashing`() = runTest {
        // Manually write corrupted ciphertext to DataStore
        val keyEncryptedJwt = stringPreferencesKey("enc_jwt_token")
        testDataStore.edit { prefs ->
            prefs[keyEncryptedJwt] = "corrupted_non_decryptable_garbage"
        }

        // Create a new TokenManager pointing to the corrupted DataStore
        val recoveryManager = TokenManager(
            context = TestContext(),
            customDataStore = testDataStore,
            customEncryptionManager = encryptionManager
        )

        val token = recoveryManager.getToken()
        assertNull("Corrupted token must resolve to null without throwing", token)
        assertTrue("State must recover to Unauthenticated", recoveryManager.tokenFlow.value is TokenState.Unauthenticated)
        assertFalse("hasCachedTokenSync must safely return false", recoveryManager.hasCachedTokenSync())
    }

    // -------------------------------------------------------------
    // 4. Auth Crash Handling & Resilience in AuthRepository / AuthViewModel
    // -------------------------------------------------------------

    @Test
    fun `AuthRepositoryImpl handles storage exceptions during login without crashing`() = runTest {
        val failingTokenManager = object : TokenManager(TestContext()) {
            override suspend fun saveTokens(accessToken: String, refreshToken: String) {
                throw IllegalStateException("Simulated hardware KeyStore failure on Android 16")
            }
        }

        val remoteDataSource = object : AuthRemoteDataSource {
            override suspend fun login(request: LoginRequestDto): NetworkResult<LoginResponseDto> {
                return NetworkResult.Success(LoginResponseDto("valid_access", "valid_refresh", null))
            }
            override suspend fun register(request: RegisterRequestDto): NetworkResult<RegisterResponseDto> = throw NotImplementedError()
            override suspend fun logout(): NetworkResult<LogoutResponseDto> = throw NotImplementedError()
            override suspend fun refreshToken(request: RefreshRequestDto): NetworkResult<RefreshResponseDto> = throw NotImplementedError()
        }

        val dispatcherProvider = object : DispatcherProvider {
            override val main: CoroutineDispatcher = testDispatcher
            override val io: CoroutineDispatcher = testDispatcher
            override val default: CoroutineDispatcher = testDispatcher
            override val unconfined: CoroutineDispatcher = testDispatcher
        }

        val repo = AuthRepositoryImpl(remoteDataSource, dispatcherProvider, failingTokenManager)
        val result = repo.login("user@test.com", "Password@123")

        assertTrue("Storage failure must be caught and returned as NetworkResult.Error", result is NetworkResult.Error)
        val error = (result as NetworkResult.Error).error
        assertTrue("Error must describe session persistence failure", error is NetworkError.Unknown)
    }

    @Test
    fun `AuthViewModel catches unexpected repository exceptions during login and displays recoverable error`() = runTest {
        val failingAuthRepo = object : com.cryptopulse.app.domain.repository.AuthRepository {
            override suspend fun login(email: String, password: String): NetworkResult<Unit> {
                throw RuntimeException("Fatal KeyStore unhandled crash simulated")
            }
            override suspend fun register(email: String, password: String, confirm: String): NetworkResult<Unit> {
                throw RuntimeException("Fatal KeyStore unhandled crash simulated")
            }
            override suspend fun logout(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun refreshToken(): NetworkResult<Unit> = NetworkResult.Success(Unit)
        }

        val fakeExchangeRepo = object : ExchangeRepository {
            override suspend fun validateKeys(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun connectExchange(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getConnectionStatus(): NetworkResult<ExchangeStatus> = NetworkResult.Success(ExchangeStatus(true, "bybit", "demo", null))
            override suspend fun getBalances(): NetworkResult<List<BalanceItem>> = NetworkResult.Success(emptyList())
        }

        val fakeExchangeConnMgr = object : ExchangeConnectionManager(TestContext()) {
            override suspend fun saveConnection(exchangeName: String, environment: String) {}
            override suspend fun clearConnection() {}
        }

        val viewModel = AuthViewModel(
            repository = failingAuthRepo,
            exchangeRepository = fakeExchangeRepo,
            exchangeConnectionManager = fakeExchangeConnMgr
        )

        viewModel.email = "test@example.com"
        viewModel.password = "ValidPass123!"

        // Trigger login — should NOT throw uncaught exception or crash JVM
        viewModel.login()

        assertFalse("isLoading must be reset to false after failure", viewModel.isLoading)
        assertFalse("isAuthenticated must remain false", viewModel.isAuthenticated)
        assertNotNull("errorMessage must be populated for user", viewModel.errorMessage)
        assertTrue("Error message must indicate failure", viewModel.errorMessage!!.contains("Fatal KeyStore"))
    }

    @Test
    fun `AuthViewModel catches unexpected repository exceptions during registration and displays recoverable error`() = runTest {
        val failingAuthRepo = object : com.cryptopulse.app.domain.repository.AuthRepository {
            override suspend fun login(email: String, password: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun register(email: String, password: String, confirm: String): NetworkResult<Unit> {
                throw RuntimeException("Fatal KeyStore unhandled crash simulated")
            }
            override suspend fun logout(): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun refreshToken(): NetworkResult<Unit> = NetworkResult.Success(Unit)
        }

        val fakeExchangeRepo = object : ExchangeRepository {
            override suspend fun validateKeys(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun connectExchange(exchangeName: String, apiKey: String, apiSecret: String, apiPassphrase: String?, environment: String): NetworkResult<Unit> = NetworkResult.Success(Unit)
            override suspend fun getConnectionStatus(): NetworkResult<ExchangeStatus> = NetworkResult.Success(ExchangeStatus(true, "bybit", "demo", null))
            override suspend fun getBalances(): NetworkResult<List<BalanceItem>> = NetworkResult.Success(emptyList())
        }

        val fakeExchangeConnMgr = object : ExchangeConnectionManager(TestContext()) {
            override suspend fun saveConnection(exchangeName: String, environment: String) {}
            override suspend fun clearConnection() {}
        }

        val viewModel = AuthViewModel(
            repository = failingAuthRepo,
            exchangeRepository = fakeExchangeRepo,
            exchangeConnectionManager = fakeExchangeConnMgr
        )

        viewModel.email = "test@example.com"
        viewModel.password = "ValidPass123!"
        viewModel.confirmPassword = "ValidPass123!"

        // Trigger registration — should NOT throw uncaught exception or crash JVM
        viewModel.register()

        assertFalse("isLoading must be reset to false after registration failure", viewModel.isLoading)
        assertFalse("isAuthenticated must remain false", viewModel.isAuthenticated)
        assertNotNull("errorMessage must be populated for user", viewModel.errorMessage)
        assertTrue("Error message must indicate failure", viewModel.errorMessage!!.contains("Fatal KeyStore"))
    }
}
