package com.cryptopulse.ui.exchange

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.data.remote.UserRepository
import com.cryptopulse.data.remote.dto.ApiKeyRequest
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ExchangeViewModel @Inject constructor(
    private val userRepository: UserRepository
) : ViewModel() {

    private val _apiKeySubmissionState = MutableStateFlow<ApiKeySubmissionState>(ApiKeySubmissionState.Idle)
    val apiKeySubmissionState: StateFlow<ApiKeySubmissionState> = _apiKeySubmissionState

    fun submitApiKeys(apiKey: String, apiSecret: String) {
        viewModelScope.launch {
            _apiKeySubmissionState.value = ApiKeySubmissionState.Loading
            try {
                val response = userRepository.submitApiKeys(ApiKeyRequest(apiKey, apiSecret))
                if (response.isSuccessful) {
                    _apiKeySubmissionState.value = ApiKeySubmissionState.Success
                } else {
                    _apiKeySubmissionState.value = ApiKeySubmissionState.Error("Failed to submit keys: ${response.message()}")
                }
            } catch (e: Exception) {
                _apiKeySubmissionState.value = ApiKeySubmissionState.Error("Network error: ${e.message}")
            }
        }
    }
}

sealed class ApiKeySubmissionState {
    object Idle : ApiKeySubmissionState()
    object Loading : ApiKeySubmissionState()
    object Success : ApiKeySubmissionState()
    data class Error(val message: String) : ApiKeySubmissionState()
}