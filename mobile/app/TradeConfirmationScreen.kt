package com.cryptopulse.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavController
import com.cryptopulse.ui.market.MarketViewModel
import com.cryptopulse.ui.navigation.Screen

@Composable
fun TradeConfirmationScreen(
    navController: NavController,
    coinId: String,
    entryPrice: Float,
    viewModel: MarketViewModel = hiltViewModel()
) {
    // These would be calculated based on the strategy
    val takeProfit = entryPrice * 1.05f
    val stopLoss = entryPrice * 0.98f
    val estimatedProfit = (takeProfit - entryPrice) * 100 // Example calculation
    val aiConfidence = 88.5f

    Scaffold(
        topBar = { TopAppBar(title = { Text("Confirm Trade") }, colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface)) }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text(coinId.uppercase(), style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(24.dp))

                // Trade Parameters
                Column(modifier = Modifier.fillMaxWidth()) {
                    InfoRow("Entry Price", "$${"%.2f".format(entryPrice)}")
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        InfoBox("Stop Loss", "$${"%.2f".format(stopLoss)}", Modifier.weight(1f))
                        InfoBox("Take Profit", "$${"%.2f".format(takeProfit)}", Modifier.weight(1f))
                    }
                }

                Spacer(modifier = Modifier.height(24.dp))

                // AI Analysis
                Column(modifier = Modifier.fillMaxWidth()) {
                    Text("AI Analysis", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 8.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        InfoBox("Est. Profit", "$${"%.2f".format(estimatedProfit)}", Modifier.weight(1f), isPrimary = true)
                        // A gauge would be better here, but for now, a box.
                        InfoBox("Confidence", "${"%.1f".format(aiConfidence)}%", Modifier.weight(1f))
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Button(
                    onClick = { navController.popBackStack() },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                ) {
                    Text("Cancel")
                }
                Button(
                    onClick = {
                        viewModel.executeTrade()
                        navController.navigate(Screen.LiveTradeMonitoring.createRoute(coinId)) {
                            popUpTo(Screen.MarketCandidates.route)
                        }
                    },
                    modifier = Modifier.weight(1f)
                ) {
                    Text("Execute Trade")
                }
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, style = MaterialTheme.typography.titleMedium)
        Text(
            value,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold
        )
    }
}

@Composable
private fun InfoBox(label: String, value: String, modifier: Modifier = Modifier, isPrimary: Boolean = false) {
    Column(
        modifier = modifier
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(8.dp))
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = LocalContentColor.current.copy(alpha = 0.7f))
        Spacer(modifier = Modifier.height(4.dp))
        Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = if (isPrimary) MaterialTheme.colorScheme.primary else LocalContentColor.current)
    }
}