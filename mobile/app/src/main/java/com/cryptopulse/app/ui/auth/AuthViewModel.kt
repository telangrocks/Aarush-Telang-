package com.cryptopulse.app.ui.auth

import com.cryptopulse.app.core.network.*
import com.cryptopulse.app.core.error.NetworkError
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.cryptopulse.app.domain.repository.AuthRepository
import com.cryptopulse.app.domain.repository.ExchangeRepository
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.domain.model.AuthResult
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.launch

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val repository: AuthRepository,
    private val exchangeRepository: ExchangeRepository,
    private val exchangeConnectionManager: ExchangeConnectionManager
) : ViewModel() {

    var email by mutableStateOf("")
    var password by mutableStateOf("")
    var confirmPassword by mutableStateOf("")

    var isLoading by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)
    var isAuthenticated by mutableStateOf(false)

    var emailError by mutableStateOf<String?>(null)
    var passwordError by mutableStateOf<String?>(null)
    var confirmPasswordError by mutableStateOf<String?>(null)

    fun clearErrors() {
        emailError = null
        passwordError = null
        confirmPasswordError = null
        errorMessage = null
    }

    fun validateRegistration(): Boolean {
        clearErrors()
        var isValid = true

        val trimmedEmail = email.trim()
        when {
            trimmedEmail.isBlank() -> {
                emailError = "Email is required."
                isValid = false
            }
            !isValidEmail(trimmedEmail) -> {
                emailError = "Please enter a valid email address."
                isValid = false
            }
        }

        when {
            password.isBlank() -> {
                passwordError = "Password is required."
                isValid = false
            }
            !isValidPassword(password) -> {
                passwordError = "Min. 8 characters with uppercase, lowercase, number and a symbol (@\$!%*?&)."
                isValid = false
            }
        }

        if (password != confirmPassword) {
            confirmPasswordError = "Passwords do not match."
            isValid = false
        }

        return isValid
    }

    fun clearError() {
        errorMessage = null
    }

    private var loginJob: kotlinx.coroutines.Job? = null
    private var registerJob: kotlinx.coroutines.Job? = null
    private var lastSubmitTimeMs: Long = 0L

    companion object {
        const val SUBMIT_DEBOUNCE_MS = 1000L
        private val EMAIL_REGEX = "^[A-Za-z0-9+_.-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$".toRegex()

        fun isValidEmail(email: String): Boolean {
            return try {
                android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()
            } catch (_: Throwable) {
                EMAIL_REGEX.matches(email)
            }
        }

        // Mirrors the server-side password policy in backend/src/handlers/user.ts
        fun isValidPassword(password: String): Boolean {
            // 1. Minimum length is 8
            if (password.length < 8) return false

            // 2. First-character restriction: must match [A-Za-z\d@$!%*?&]
            val firstChar = password.firstOrNull() ?: return false
            val isFirstCharAllowed = (firstChar in 'a'..'z') ||
                    (firstChar in 'A'..'Z') ||
                    (firstChar in '0'..'9') ||
                    (firstChar in setOf('@', '$', '!', '%', '*', '?', '&'))
            if (!isFirstCharAllowed) return false

            // 3. Positive lookaheads anywhere in string:
            var hasLower = false
            var hasUpper = false
            var hasDigit = false
            var hasRequiredSymbol = false
            val requiredSymbols = setOf('@', '$', '!', '%', '*', '?', '&')

            for (c in password) {
                if (c in 'a'..'z') hasLower = true
                if (c in 'A'..'Z') hasUpper = true
                if (c in '0'..'9') hasDigit = true
                if (c in requiredSymbols) hasRequiredSymbol = true
            }

            return hasLower && hasUpper && hasDigit && hasRequiredSymbol
        }
    }

    private fun extractErrorMessage(error: NetworkError): String {
        return when (error) {
            is NetworkError.HttpError -> error.message.ifBlank { "Request failed (${error.code})" }
            is NetworkError.Unauthorized -> "Invalid credentials."
            is NetworkError.Forbidden -> "Access denied."
            is NetworkError.NotFound -> "Resource not found."
            is NetworkError.Timeout -> "Network timeout. Please check your connection."
            is NetworkError.Serialization -> "Data format error. Please try again."
            is NetworkError.Unknown -> error.error.message ?: "An unexpected network error occurred."
        }
    }

    fun register() {
        if (!validateRegistration()) return

        val now = System.currentTimeMillis()
        if (now - lastSubmitTimeMs < SUBMIT_DEBOUNCE_MS) {
            return
        }
        if (isLoading || registerJob?.isActive == true) {
            return
        }
        lastSubmitTimeMs = now

        registerJob = viewModelScope.launch {
            isLoading = true
            errorMessage = null

            try {
                when (val result = repository.register(email.trim(), password, confirmPassword)) {
                    is NetworkResult.Success -> {
                        isAuthenticated = true
                    }
                    is NetworkResult.Error -> {
                        errorMessage = extractErrorMessage(result.error)
                    }
                    else -> {}
                }
            } finally {
                isLoading = false
            }
        }
    }

    fun login() {
        clearErrors()

        val trimmedEmail = email.trim()
        when {
            trimmedEmail.isBlank() -> {
                emailError = "Email is required."
                return
            }
            !isValidEmail(trimmedEmail) -> {
                emailError = "Please enter a valid email address."
                return
            }
            password.isBlank() -> {
                passwordError = "Password is required."
                return
            }
        }

        // Active coroutine & duplicate submission protection (1,000ms debounce)
        val now = System.currentTimeMillis()
        if (now - lastSubmitTimeMs < SUBMIT_DEBOUNCE_MS) {
            return
        }
        if (isLoading || loginJob?.isActive == true) {
            return
        }
        lastSubmitTimeMs = now

        loginJob = viewModelScope.launch {
            isLoading = true
            errorMessage = null

            try {
                when (val result = repository.login(trimmedEmail, password)) {
                    is NetworkResult.Success -> {
                        try {
                            val statusResult = exchangeRepository.getConnectionStatus()
                            if (statusResult is NetworkResult.Success && statusResult.data.isConnected) {
                                val status = statusResult.data
                                exchangeConnectionManager.saveConnection(
                                    status.exchangeName ?: "bybit",
                                    status.environment ?: "demo"
                                )
                            } else {
                                exchangeConnectionManager.clearConnection()
                            }
                        } catch (_: Exception) {}
                        isAuthenticated = true
                    }
                    is NetworkResult.Error -> {
                        errorMessage = extractErrorMessage(result.error)
                    }
                    else -> {}
                }
            } finally {
                isLoading = false
            }
        }
    }
}




