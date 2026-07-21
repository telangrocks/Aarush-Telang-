package com.cryptopulse.app.ui.strategies

import com.cryptopulse.app.domain.models.Strategy

sealed interface StrategySelectionState {
    object Loading : StrategySelectionState
    data class Success(val strategies: List<Strategy>) : StrategySelectionState
    object Empty : StrategySelectionState
    data class Error(val message: String) : StrategySelectionState
}
