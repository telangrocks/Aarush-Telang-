package com.cryptopulse.app.ui.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.repository.AuthRepository
import com.cryptopulse.app.domain.model.AuthResult
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.launch

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val repository: AuthRepository
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
            !android.util.Patterns.EMAIL_ADDRESS.matcher(trimmedEmail).matches() -> {
                emailError = "Please enter a valid email address."
                isValid = false
            }
        }

        when {
            password.isBlank() -> {
                passwordError = "Password is required."
                isValid = false
            }
            password.length < 8 -> {
                passwordError = "Password must be at least 8 characters."
                isValid = false
            }
        }

        when {
            confirmPassword.isBlank() -> {
                confirmPasswordError = "Please confirm your password."
                isValid = false
            }
            password != confirmPassword -> {
                confirmPasswordError = "Passwords do not match."
                isValid = false
            }
        }

        return isValid
    }

    fun register() {
        if (!validateRegistration()) return

        viewModelScope.launch {
            isLoading = true
            errorMessage = null

            when (val result = repository.register(email.trim(), password)) {
                is AuthResult.Success -> {
                    isAuthenticated = true
                }
                is AuthResult.Error -> {
                    errorMessage = result.message
                }
                else -> {}
            }
            isLoading = false
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
            !android.util.Patterns.EMAIL_ADDRESS.matcher(trimmedEmail).matches() -> {
                emailError = "Please enter a valid email address."
                return
            }
            password.isBlank() -> {
                passwordError = "Password is required."
                return
            }
        }

        viewModelScope.launch {
            isLoading = true
            errorMessage = null

            when (val result = repository.login(trimmedEmail, password)) {
                is AuthResult.Success -> {
                    isAuthenticated = true
                }
                is AuthResult.Error -> {
                    errorMessage = result.message
                }
                else -> {}
            }
            isLoading = false
        }
    }

    fun clearError() {
        errorMessage = null
    }
}
