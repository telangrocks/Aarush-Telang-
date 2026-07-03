package com.cryptopulse.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.data.remote.AuthRepository
import com.cryptopulse.data.remote.dto.LoginRequest
import com.cryptopulse.data.remote.dto.RegisterRequest
import com.cryptopulse.data.remote.dto.VerifyOtpRequest
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val authRepository: AuthRepository
) : ViewModel() {

    private val _authState = MutableStateFlow<AuthState>(AuthState.Idle)
    val authState: StateFlow<AuthState> = _authState

    fun registerUser(email: String, password: String) {
        viewModelScope.launch {
            _authState.value = AuthState.Loading
            try {
                val response = authRepository.register(RegisterRequest(email, password))
                if (response.isSuccessful && response.body() != null) {
                    _authState.value = AuthState.RegistrationSuccess(email)
                } else {
                    _authState.value = AuthState.Error("Registration failed: ${response.message()}")
                }
            } catch (e: Exception) {
                _authState.value = AuthState.Error("Network error: ${e.message}")
            }
        }
    }

    fun verifyOtp(email: String, otp: String) {
        viewModelScope.launch {
            _authState.value = AuthState.Loading
            try {
                val response = authRepository.verifyOtp(VerifyOtpRequest(email, otp))
                if (response.isSuccessful && response.body() != null) {
                    // Assuming the response contains a token
                    _authState.value = AuthState.LoginSuccess(response.body()!!.token)
                } else {
                    _authState.value = AuthState.Error("OTP verification failed: ${response.message()}")
                }
            } catch (e: Exception) {
                _authState.value = AuthState.Error("Network error: ${e.message}")
            }
        }
    }

    fun login(email: String, password: String) {
        viewModelScope.launch {
            _authState.value = AuthState.Loading
            try {
                val response = authRepository.login(LoginRequest(email, password))
                if (response.isSuccessful && response.body() != null) {
                    _authState.value = AuthState.LoginSuccess(response.body()!!.token)
                } else {
                    _authState.value = AuthState.Error("Login failed: ${response.message()}")
                }
            } catch (e: Exception) {
                _authState.value = AuthState.Error("Network error: ${e.message}")
            }
        }
    }

    fun resetState() {
        _authState.value = AuthState.Idle
    }
}

sealed class AuthState {
    object Idle : AuthState()
    object Loading : AuthState()
    data class RegistrationSuccess(val email: String) : AuthState()
    data class LoginSuccess(val token: String) : AuthState()
    data class Error(val message: String) : AuthState()
}