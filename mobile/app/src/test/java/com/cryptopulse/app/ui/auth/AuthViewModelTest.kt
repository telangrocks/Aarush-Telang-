package com.cryptopulse.app.ui.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.test.resetMain

class AuthViewModelTest {

    @Test
    fun testCase1_validStandardAsciiPassword() {
        // Case 1: Length >= 8, upper, lower, digit, symbol, valid first char
        assertTrue(AuthViewModel.isValidPassword("Pass1234@"))
    }

    @Test
    fun testCase2_invalidFirstCharacter() {
        // Case 2: '#' is not in [A-Za-z\d@$!%*?&]
        assertFalse(AuthViewModel.isValidPassword("#Pass1234@"))
    }

    @Test
    fun testCase3_missingLowercaseLetter() {
        // Case 3: Fails (?=.*[a-z])
        assertFalse(AuthViewModel.isValidPassword("PASS1234@"))
    }

    @Test
    fun testCase4_missingUppercaseLetter() {
        // Case 4: Fails (?=.*[A-Z])
        assertFalse(AuthViewModel.isValidPassword("pass1234@"))
    }

    @Test
    fun testCase5_missingDigit() {
        // Case 5: Fails (?=.*\d)
        assertFalse(AuthViewModel.isValidPassword("PassWord@@"))
    }

    @Test
    fun testCase6_missingRequiredSymbol() {
        // Case 6: Fails (?=.*[@$!%*?&])
        assertFalse(AuthViewModel.isValidPassword("Pass12345"))
    }

    @Test
    fun testCase7_lessThan8Characters() {
        // Case 7: Length 6 < 8
        assertFalse(AuthViewModel.isValidPassword("Pass1@"))
    }

    @Test
    fun testCase8_unicodeCharacterAfterFirstChar() {
        // Case 8: Length 10, valid 1st char, all lookaheads met, unicode 'é' after 1st char allowed
        assertTrue(AuthViewModel.isValidPassword("Pass1234@é"))
    }

    @Test
    fun testCase9_spaceAfterFirstChar() {
        // Case 9: Length 10, valid 1st char, all lookaheads met, space after 1st char allowed
        assertTrue(AuthViewModel.isValidPassword("Pass 1234@"))
    }

    @Test
    fun testCase10_dashOrUnderscoreAfterFirstChar() {
        // Case 10: Length 11, valid 1st char, all lookaheads met, '-' and '_' after 1st char allowed
        assertTrue(AuthViewModel.isValidPassword("Pass-1234_@"))
    }

    @Test
    fun testThreeRapidLoginCalls_dispatchesExactlyOneRequest() = kotlinx.coroutines.test.runTest {
        val testDispatcher = kotlinx.coroutines.test.StandardTestDispatcher(testScheduler)
        kotlinx.coroutines.Dispatchers.setMain(testDispatcher)
        try {
            val fakeAuthRepo = FakeAuthRepository().apply {
                loginDelayMs = 200L
            }
            val viewModel = AuthViewModel(
                repository = fakeAuthRepo,
                exchangeRepository = FakeExchangeRepository(),
                exchangeConnectionManager = FakeExchangeConnectionManagerMinimal()
            )
            viewModel.email = "test@example.com"
            viewModel.password = "ValidPass123!"

            // Fire 3 rapid login calls within the debounce / active job window
            viewModel.login()
            viewModel.login()
            viewModel.login()

            testScheduler.advanceUntilIdle()

            // Exactly one request was dispatched
            assertEquals(1, fakeAuthRepo.loginCallCount)
            assertFalse(viewModel.isLoading)
        } finally {
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun testHttp429Response_displaysCleanServerMessage() = kotlinx.coroutines.test.runTest {
        val testDispatcher = kotlinx.coroutines.test.StandardTestDispatcher(testScheduler)
        kotlinx.coroutines.Dispatchers.setMain(testDispatcher)
        try {
            val fakeAuthRepo = FakeAuthRepository().apply {
                loginResult = com.cryptopulse.app.core.network.NetworkResult.Error(
                    com.cryptopulse.app.core.error.NetworkError.HttpError(
                        code = 429,
                        message = "Too many login attempts. Please try again later."
                    )
                )
            }
            val viewModel = AuthViewModel(
                repository = fakeAuthRepo,
                exchangeRepository = FakeExchangeRepository(),
                exchangeConnectionManager = FakeExchangeConnectionManagerMinimal()
            )
            viewModel.email = "test@example.com"
            viewModel.password = "ValidPass123!"

            viewModel.login()
            testScheduler.advanceUntilIdle()

            assertEquals("Too many login attempts. Please try again later.", viewModel.errorMessage)
            assertFalse(viewModel.errorMessage!!.contains("HttpError"))
            assertFalse(viewModel.isLoading)
        } finally {
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun testHttp401Response_displaysCleanInvalidCredentialsMessage() = kotlinx.coroutines.test.runTest {
        val testDispatcher = kotlinx.coroutines.test.StandardTestDispatcher(testScheduler)
        kotlinx.coroutines.Dispatchers.setMain(testDispatcher)
        try {
            val fakeAuthRepo = FakeAuthRepository().apply {
                loginResult = com.cryptopulse.app.core.network.NetworkResult.Error(
                    com.cryptopulse.app.core.error.NetworkError.HttpError(
                        code = 401,
                        message = "Invalid credentials."
                    )
                )
            }
            val viewModel = AuthViewModel(
                repository = fakeAuthRepo,
                exchangeRepository = FakeExchangeRepository(),
                exchangeConnectionManager = FakeExchangeConnectionManagerMinimal()
            )
            viewModel.email = "test@example.com"
            viewModel.password = "ValidPass123!"

            viewModel.login()
            testScheduler.advanceUntilIdle()

            assertEquals("Invalid credentials.", viewModel.errorMessage)
            assertFalse(viewModel.errorMessage!!.contains("HttpError"))
            assertFalse(viewModel.isLoading)
        } finally {
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun testLoadingStateRestored_afterSuccess() = kotlinx.coroutines.test.runTest {
        val testDispatcher = kotlinx.coroutines.test.StandardTestDispatcher(testScheduler)
        kotlinx.coroutines.Dispatchers.setMain(testDispatcher)
        try {
            val fakeAuthRepo = FakeAuthRepository().apply {
                loginResult = com.cryptopulse.app.core.network.NetworkResult.Success(Unit)
            }
            val viewModel = AuthViewModel(
                repository = fakeAuthRepo,
                exchangeRepository = FakeExchangeRepository(),
                exchangeConnectionManager = FakeExchangeConnectionManagerMinimal()
            )
            viewModel.email = "test@example.com"
            viewModel.password = "ValidPass123!"

            viewModel.login()
            testScheduler.advanceUntilIdle()

            assertTrue(viewModel.isAuthenticated)
            assertFalse(viewModel.isLoading)
        } finally {
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun testLoadingStateRestored_afterError() = kotlinx.coroutines.test.runTest {
        val testDispatcher = kotlinx.coroutines.test.StandardTestDispatcher(testScheduler)
        kotlinx.coroutines.Dispatchers.setMain(testDispatcher)
        try {
            val fakeAuthRepo = FakeAuthRepository().apply {
                loginResult = com.cryptopulse.app.core.network.NetworkResult.Error(
                    com.cryptopulse.app.core.error.NetworkError.Timeout
                )
            }
            val viewModel = AuthViewModel(
                repository = fakeAuthRepo,
                exchangeRepository = FakeExchangeRepository(),
                exchangeConnectionManager = FakeExchangeConnectionManagerMinimal()
            )
            viewModel.email = "test@example.com"
            viewModel.password = "ValidPass123!"

            viewModel.login()
            testScheduler.advanceUntilIdle()

            assertEquals("Network timeout. Please check your connection.", viewModel.errorMessage)
            assertFalse(viewModel.isLoading)
        } finally {
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }
}

class FakeAuthRepository : com.cryptopulse.app.domain.repository.AuthRepository {
    var loginCallCount = 0
    var registerCallCount = 0
    var loginResult: com.cryptopulse.app.core.network.NetworkResult<Unit> = com.cryptopulse.app.core.network.NetworkResult.Success(Unit)
    var registerResult: com.cryptopulse.app.core.network.NetworkResult<Unit> = com.cryptopulse.app.core.network.NetworkResult.Success(Unit)
    var loginDelayMs: Long = 0L

    override suspend fun login(email: String, password: String): com.cryptopulse.app.core.network.NetworkResult<Unit> {
        loginCallCount++
        if (loginDelayMs > 0) {
            kotlinx.coroutines.delay(loginDelayMs)
        }
        return loginResult
    }

    override suspend fun register(email: String, password: String, confirm: String): com.cryptopulse.app.core.network.NetworkResult<Unit> {
        registerCallCount++
        return registerResult
    }

    override suspend fun logout(): com.cryptopulse.app.core.network.NetworkResult<Unit> = com.cryptopulse.app.core.network.NetworkResult.Success(Unit)
    override suspend fun refreshToken(): com.cryptopulse.app.core.network.NetworkResult<Unit> = com.cryptopulse.app.core.network.NetworkResult.Success(Unit)
}


