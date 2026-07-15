package com.cryptopulse.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.api.AnalysisLog
import com.cryptopulse.app.data.api.AnalysisStatusResponse
import com.cryptopulse.app.data.api.Checkpoint
import com.cryptopulse.app.data.api.NearMatch
import com.cryptopulse.app.data.api.ScanCandidate
import com.cryptopulse.app.data.api.TradingBotService
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class LiveAnalysisViewModel @Inject constructor(
    private val tradingBotService: com.cryptopulse.app.data.api.TradingBotService,
) : ViewModel() {

    private val _analysisState = MutableStateFlow<AnalysisStatusResponse?>(null)
    val analysisState: StateFlow<AnalysisStatusResponse?> = _analysisState

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    private var pollingJob: Job? = null

    fun startPolling() {
        stopPolling()
        _isLoading.value = true
        _error.value = null
        pollingJob = viewModelScope.launch {
            while (true) {
                try {
                    val response = tradingBotService.getAnalysisStatus()
                    if (response.isSuccessful && response.body() != null) {
                        _analysisState.value = response.body()
                        _error.value = null
                        _isLoading.value = false
                    } else {
                        _error.value = "Failed to load analysis status"
                        _isLoading.value = false
                    }
                } catch (e: Exception) {
                    _error.value = e.message ?: "Network error"
                    _isLoading.value = false
                }
                delay(2000)
            }
        }
    }

    fun stopPolling() {
        pollingJob?.cancel()
        pollingJob = null
    }

    override fun onCleared() {
        super.onCleared()
        stopPolling()
    }
}
