package com.cryptopulse.app.ui.strategies

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.api.AnalysisApi
import com.cryptopulse.app.data.api.BotActivateRequest
import com.cryptopulse.app.data.api.TechnicalAnalysisRequest
import com.cryptopulse.app.data.repository.TradeSessionRepository
import com.cryptopulse.app.domain.models.TradeSetupConfig
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class TechnicalAnalysisViewModel @Inject constructor(
    private val sessionRepository: TradeSessionRepository,
    private val api: AnalysisApi
) : ViewModel() {
    
    val tradeSetupConfig: StateFlow<TradeSetupConfig?> = sessionRepository.tradeSetupConfig

    private val _analysisStatus = MutableStateFlow<String>("Idle")
    val analysisStatus = _analysisStatus.asStateFlow()

    fun runAnalysis() {
        val config = tradeSetupConfig.value ?: return
        viewModelScope.launch {
            try {
                _analysisStatus.value = "Running Analysis..."
                val response = api.getTechnicalAnalysis(
                    TechnicalAnalysisRequest(
                        symbol = "BTC-PERP", // Hardcoded for now
                        strategy = config.strategyId,
                        config = config.parameters
                    )
                )
                _analysisStatus.value = "Analysis Complete. Confidence: ${response.signals.confidence}"
            } catch (e: Exception) {
                _analysisStatus.value = "Analysis Failed: ${e.message}"
            }
        }
    }

    fun startBot() {
        val config = tradeSetupConfig.value ?: return
        viewModelScope.launch {
            try {
                _analysisStatus.value = "Activating Bot..."
                val response = api.activateBot(
                    BotActivateRequest(
                        coinId = "BTC-PERP",
                        strategy = config.strategyId,
                        positionSize = null,
                        targetEntryPrice = null,
                        config = config.parameters
                    )
                )
                _analysisStatus.value = if (response.success) "Bot Activated!" else "Bot Activation Failed"
            } catch (e: Exception) {
                _analysisStatus.value = "Activation Failed: ${e.message}"
            }
        }
    }
}
