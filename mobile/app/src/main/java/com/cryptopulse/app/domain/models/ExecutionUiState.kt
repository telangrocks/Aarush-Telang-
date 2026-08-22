package com.cryptopulse.app.domain.models

sealed interface ExecutionUiState {
    object Idle : ExecutionUiState
    data class Submitting(val alertId: String) : ExecutionUiState
    data class AwaitingFill(val positionId: String, val alertId: String, val symbol: String, val side: String) : ExecutionUiState
    data class Filled(val result: TradeExecutionResult) : ExecutionUiState
    data class Failed(val message: String, val canRetry: Boolean = true) : ExecutionUiState
}
