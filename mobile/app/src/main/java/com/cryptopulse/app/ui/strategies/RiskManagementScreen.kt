package com.cryptopulse.app.ui.strategies

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.TradeSetupConfig

@Composable
fun RiskManagementScreen(
    strategy: Strategy,
    viewModel: RiskManagementViewModel,
    onActivateBot: (TradeSetupConfig) -> Unit,
    onBack: () -> Unit
) {
    LaunchedEffect(strategy) {
        viewModel.initialize(strategy)
    }

    val state by viewModel.state.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        Text("Risk Management", style = MaterialTheme.typography.headlineMedium)
        Spacer(modifier = Modifier.height(24.dp))

        Text("Selected Strategy: ${state.selectedStrategy?.name ?: ""}")
        Text("Selected Pair: ${state.tradeSetupConfig?.symbol ?: ""}")
        Spacer(modifier = Modifier.height(24.dp))

        Text("Account Risk per Trade (%)")
        if (state.accountRiskPercent != null) {
            Slider(
                value = state.accountRiskPercent!!.toFloat(),
                onValueChange = { viewModel.updateAccountRisk(it.toDouble()) },
                valueRange = 0.1f..5.0f,
                steps = 49
            )
            Text(String.format("%.1f", state.accountRiskPercent!!))
        } else {
            Text("No default specified by strategy.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(modifier = Modifier.height(16.dp))

        Text("Risk / Reward Ratio")
        if (state.riskRewardRatio != null) {
            Slider(
                value = state.riskRewardRatio!!.toFloat(),
                onValueChange = { viewModel.updateRiskReward(it.toDouble()) },
                valueRange = 1.0f..5.0f,
                steps = 40
            )
            Text(String.format("%.1f", state.riskRewardRatio!!))
        } else {
            Text("No default specified by strategy.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(modifier = Modifier.height(16.dp))

        Text("Stop Loss Distance (ATR)")
        if (state.atrStopLossMultiplier != null) {
            Slider(
                value = state.atrStopLossMultiplier!!.toFloat(),
                onValueChange = { viewModel.updateAtrStopLoss(it.toDouble()) },
                valueRange = 0.5f..5.0f,
                steps = 45
            )
            Text(String.format("%.1f", state.atrStopLossMultiplier!!))
        } else {
            Text("No default specified by strategy.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(modifier = Modifier.height(32.dp))

        Button(
            onClick = {
                val updatedConfig = viewModel.getUpdatedConfig()
                if (updatedConfig != null) {
                    onActivateBot(updatedConfig)
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("ACTIVATE TRADING BOT")
        }
        Spacer(modifier = Modifier.height(8.dp))
        OutlinedButton(
            onClick = onBack,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Back")
        }
    }
}
