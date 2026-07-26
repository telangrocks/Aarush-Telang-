package com.cryptopulse.app.data.transport

import com.cryptopulse.app.domain.models.AnalysisSnapshot
import kotlinx.coroutines.flow.StateFlow

interface ITransportAdapter {
    val analysisState: StateFlow<AnalysisSnapshot?>
    val isConnected: StateFlow<Boolean>
    val transportType: String
    
    fun startObserving()
    fun stopObserving()
}
