package com.cryptopulse.app.data.transport

import com.cryptopulse.app.data.api.TradingBotService
import com.cryptopulse.app.domain.models.AnalysisSnapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class PollingTransportAdapter(
    private val tradingBotService: TradingBotService,
    private val pollIntervalMs: Long = 3000L
) : ITransportAdapter {

    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private var pollingJob: Job? = null

    private val _analysisState = MutableStateFlow<AnalysisSnapshot?>(null)
    override val analysisState: StateFlow<AnalysisSnapshot?> = _analysisState.asStateFlow()

    private val _isConnected = MutableStateFlow(false)
    override val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

    override val transportType: String = "POLLING"

    override fun startObserving() {
        if (pollingJob?.isActive == true) return
        pollingJob = scope.launch {
            _isConnected.value = true
            while (pollingJob?.isActive == true) {
                try {
                    val response = tradingBotService.getAnalysisStatus()
                    if (response.isSuccessful && response.body() != null) {
                        _analysisState.value = response.body()
                    }
                } catch (e: Exception) {
                    _isConnected.value = false
                }
                delay(pollIntervalMs)
            }
        }
    }

    override fun stopObserving() {
        pollingJob?.cancel()
        pollingJob = null
        _isConnected.value = false
    }
}
