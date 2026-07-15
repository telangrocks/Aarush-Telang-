package com.cryptopulse.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.api.AnalysisLog
import com.cryptopulse.app.data.api.AnalysisStatusResponse
import com.cryptopulse.app.data.api.BotAlert
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

    /**
     * The genuine trade opportunity detected by the backend analysis engine.
     * When the backend's strategy conditions are all satisfied (analysis at
     * 100%) it raises a real alert; this flow surfaces it so the UI can show
     * the trade popup in lock-step with the engine.
     */
    private val _pendingAlert = MutableStateFlow<BotAlert?>(null)
    val pendingAlert: StateFlow<BotAlert?> = _pendingAlert

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

                    // The analysis screen and the trade detection engine are the
                    // same workflow: poll the live alert queue so a detected
                    // opportunity appears the instant the backend raises it.
                    try {
                        val alertsResponse = tradingBotService.getAlerts()
                        if (alertsResponse.isSuccessful && alertsResponse.body() != null) {
                            val alerts = alertsResponse.body()!!
                            _pendingAlert.value = if (alerts.isNotEmpty()) BotAlert.fromMap(alerts.first()) else null
                        }
                    } catch (e: Exception) {
                        // Alert polling is best-effort; never block analysis rendering.
                    }
                } catch (e: Exception) {
                    _error.value = e.message ?: "Network error"
                    _isLoading.value = false
                }
                delay(2000)
            }
        }
    }

    fun clearPendingAlert() {
        _pendingAlert.value = null
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
