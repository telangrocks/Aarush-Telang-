package com.cryptopulse.app.ui.strategies

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cryptopulse.app.data.repository.StrategyRepository
import com.cryptopulse.app.data.repository.TradeSessionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class StrategySelectionViewModel @Inject constructor(
    private val repository: StrategyRepository,
    private val sessionRepository: TradeSessionRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow<StrategySelectionState>(StrategySelectionState.Loading)
    val uiState: StateFlow<StrategySelectionState> = _uiState.asStateFlow()

    val selectedStrategyId: StateFlow<String?> = sessionRepository.selectedStrategyId

    init {
        loadStrategies()
    }

    fun loadStrategies() {
        viewModelScope.launch {
            _uiState.value = StrategySelectionState.Loading
            val result = repository.getStrategies()
            result.onSuccess { strategies ->
                if (strategies.isEmpty()) {
                    _uiState.value = StrategySelectionState.Empty
                } else {
                    _uiState.value = StrategySelectionState.Success(strategies)
                }
            }.onFailure { error ->
                _uiState.value = StrategySelectionState.Error(error.message ?: "An unknown error occurred")
            }
        }
    }

    fun selectStrategy(id: String) {
        sessionRepository.setStrategyId(id)
    }
}
