package com.cryptopulse.app.ui.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.repository.AuthRepository
import com.cryptopulse.app.domain.model.AuthResult
import kotlinx.coroutines.launch

import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val repository: AuthRepository
) : ViewModel() {

    var email by mutableStateOf("")
    var password by mutableStateOf("")
    var otp by mutableStateOf("")
    
    var isLoading by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)
    var isOtpSent by mutableStateOf(false)
    var isAuthenticated by mutableStateOf(false)

    fun register() {
        if (email.isBlank() || password.length < 8) {
            errorMessage = "Please enter a valid email and a password of at least 8 characters."
            return
        }

        viewModelScope.launch {
            isLoading = true
            errorMessage = null
            
            when (val result = repository.register(email, password)) {
                is AuthResult.Success -> {
                    isOtpSent = true
                }
                is AuthResult.Error -> {
                    errorMessage = result.message
                }
                else -> {}
            }
            isLoading = false
        }
    }

    fun verifyOtp() {
        if (otp.length != 6) {
            errorMessage = "Please enter a valid 6-digit OTP."
            return
        }

        viewModelScope.launch {
            isLoading = true
            errorMessage = null

            when (val result = repository.verifyOtp(email, otp)) {
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
