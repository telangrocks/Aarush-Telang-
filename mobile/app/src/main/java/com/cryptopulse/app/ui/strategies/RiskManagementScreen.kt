package com.cryptopulse.app.ui.strategies

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RiskManagementScreen(
    strategy: Strategy? = null,
    viewModel: RiskManagementViewModel,
    onProceedToAnalysis: (TradeSetupConfig) -> Unit,
    onBack: () -> Unit
) {
    LaunchedEffect(strategy) {
        viewModel.initialize(strategy)
    }

    val state by viewModel.state.collectAsState()
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    Scaffold(
        topBar = { CryptoPulseTopBar(onBack = onBack) },
        containerColor = Color.Transparent,
        bottomBar = {
            Surface(
                color = NavyDeep,
                modifier = Modifier.fillMaxWidth()
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding(),
                    contentAlignment = Alignment.Center
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .widthIn(max = 680.dp)
                            .padding(horizontal = 16.dp, vertical = 12.dp)
                    ) {
                        GradientButton(
                            text = "PROCEED TO TECHNICAL ANALYSIS",
                            onClick = {
                                val updatedConfig = viewModel.getUpdatedConfig()
                                if (updatedConfig != null) {
                                    onProceedToAnalysis(updatedConfig)
                                }
                            },
                            enabled = true,
                        )
                    }
                }
            }
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(bgGradient)
                .padding(padding),
            contentAlignment = Alignment.TopCenter
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 680.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 12.dp)
            ) {
                Spacer(Modifier.height(4.dp))

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(
                        imageVector = Icons.Default.Shield,
                        contentDescription = null,
                        tint = CyanPrimary,
                        modifier = Modifier.size(22.dp)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "RISK MANAGEMENT",
                        color = CyanPrimary,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 20.sp,
                        letterSpacing = 1.5.sp,
                    )
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Strategy and Pair Info Card
                GlowCard(modifier = Modifier.fillMaxWidth()) {
                    Column {
                        if (state.selectedStrategy != null) {
                            Text(
                                text = "Selected Strategy: ${state.selectedStrategy?.name ?: ""}",
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                            Spacer(Modifier.height(4.dp))
                        }
                        Text(
                            text = "Selected Pair: ${state.tradeSetupConfig?.symbol ?: ""}",
                            color = TextSecondary,
                            fontSize = 13.sp
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Account Risk per Trade
                GlowCard(modifier = Modifier.fillMaxWidth()) {
                    Column {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "ACCOUNT RISK PER TRADE",
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 12.sp,
                                letterSpacing = 1.sp
                            )
                            if (state.accountRiskPercent != null) {
                                Text(
                                    text = String.format(java.util.Locale.US, "%.1f%%", state.accountRiskPercent!!),
                                    color = CyanPrimary,
                                    fontWeight = FontWeight.ExtraBold,
                                    fontSize = 14.sp,
                                    style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                                )
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        if (state.accountRiskPercent != null) {
                            Slider(
                                value = state.accountRiskPercent!!.toFloat(),
                                onValueChange = { viewModel.updateAccountRisk(it.toDouble()) },
                                valueRange = 0.1f..5.0f,
                                steps = 49,
                                colors = SliderDefaults.colors(
                                    thumbColor = CyanPrimary,
                                    activeTrackColor = CyanPrimary,
                                    inactiveTrackColor = NavyBorder
                                )
                            )
                        } else {
                            Text(
                                "No default specified by strategy.",
                                color = LossRed,
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Risk / Reward Ratio
                GlowCard(modifier = Modifier.fillMaxWidth()) {
                    Column {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "RISK / REWARD RATIO",
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 12.sp,
                                letterSpacing = 1.sp
                            )
                            if (state.riskRewardRatio != null) {
                                Text(
                                    text = String.format(java.util.Locale.US, "1:%.1f", state.riskRewardRatio!!),
                                    color = ProfitGreen,
                                    fontWeight = FontWeight.ExtraBold,
                                    fontSize = 14.sp,
                                    style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                                )
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        if (state.riskRewardRatio != null) {
                            Slider(
                                value = state.riskRewardRatio!!.toFloat(),
                                onValueChange = { viewModel.updateRiskReward(it.toDouble()) },
                                valueRange = 1.0f..5.0f,
                                steps = 40,
                                colors = SliderDefaults.colors(
                                    thumbColor = ProfitGreen,
                                    activeTrackColor = ProfitGreen,
                                    inactiveTrackColor = NavyBorder
                                )
                            )
                        } else {
                            Text(
                                "No default specified by strategy.",
                                color = LossRed,
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Stop Loss Distance (ATR)
                GlowCard(modifier = Modifier.fillMaxWidth()) {
                    Column {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "STOP LOSS DISTANCE (ATR)",
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 12.sp,
                                letterSpacing = 1.sp
                            )
                            if (state.atrStopLossMultiplier != null) {
                                Text(
                                    text = String.format(java.util.Locale.US, "%.1fx", state.atrStopLossMultiplier!!),
                                    color = WarningOrange,
                                    fontWeight = FontWeight.ExtraBold,
                                    fontSize = 14.sp,
                                    style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                                )
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        if (state.atrStopLossMultiplier != null) {
                            Slider(
                                value = state.atrStopLossMultiplier!!.toFloat(),
                                onValueChange = { viewModel.updateAtrStopLoss(it.toDouble()) },
                                valueRange = 0.5f..5.0f,
                                steps = 45,
                                colors = SliderDefaults.colors(
                                    thumbColor = WarningOrange,
                                    activeTrackColor = WarningOrange,
                                    inactiveTrackColor = NavyBorder
                                )
                            )
                        } else {
                            Text(
                                "No default specified by strategy.",
                                color = LossRed,
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(32.dp))
            }
        }
    }
}
