package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
import com.cryptopulse.app.domain.models.AnalysisSnapshot
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.ui.components.CoinInfoCard
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.theme.*
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.cryptopulse.app.ui.components.GradientButton

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TechnicalAnalysisScreen(
    candidate: MarketCandidate,
    analysisState: AnalysisSnapshot?,
    tradeSetupConfig: TradeSetupConfig? = null,
    onBack: () -> Unit,
    onExecuteMockTrade: (Map<String, Any>) -> Unit
) {
    val context = LocalContext.current
    val bgGradient = remember { Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020))) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgGradient)
    ) {
        Scaffold(
            topBar = { CryptoPulseTopBar(onBack = onBack) },
            containerColor = Color.Transparent,
            bottomBar = {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(NavyDeep)
                        .padding(horizontal = 20.dp, vertical = 12.dp)
                ) {
                    GradientButton(
                        text = "EXECUTE MOCK TRADE",
                        onClick = {
                            val configuredUsdt = tradeSetupConfig?.tradeValueUsdt
                            if (configuredUsdt != null && configuredUsdt > 0.0) {
                                val currentPrice = candidate.currentMarketPrice
                                val mockAlert = mapOf<String, Any>(
                                    "id" to "mock-alert-${System.currentTimeMillis()}",
                                    "symbol" to candidate.symbol,
                                    "side" to "BUY",
                                    "entryPrice" to currentPrice,
                                    "stopLoss" to (currentPrice * 0.985),
                                    "takeProfit" to (currentPrice * 1.03),
                                    "signalPrice" to currentPrice,
                                    "targetEntryPrice" to currentPrice,
                                    "positionSize" to configuredUsdt,
                                    "estimatedPnl" to (configuredUsdt * 0.03)
                                )
                                onExecuteMockTrade(mockAlert)
                            } else {
                                android.widget.Toast.makeText(
                                    context,
                                    "No active Trade Setup found. Please configure trade amount in Trade Setup first.",
                                    android.widget.Toast.LENGTH_LONG
                                ).show()
                            }
                        },
                        enabled = true,
                        leadingIcon = Icons.Default.Bolt,
                        testTag = "execute_mock_trade_button"
                    )
                }
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp)
            ) {
                Spacer(Modifier.height(12.dp))

                Text(
                    text = "TECHNICAL ANALYSIS DASHBOARD",
                    color = CyanPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 20.sp,
                    letterSpacing = 1.5.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(4.dp))
                val rawState = analysisState?.engineStatus?.state ?: "ANALYSING"
                val displayState = if (rawState == "WAITING") "ACTIVE" else rawState

                Text(
                    text = "${candidate.pairName} • Live Engine State: $displayState",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(Modifier.height(14.dp))

                CoinInfoCard(candidate = candidate)

                Spacer(Modifier.height(14.dp))

                if (analysisState == null) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(200.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator(color = CyanPrimary)
                            Spacer(Modifier.height(12.dp))
                            Text("Connecting to backend trading engine...", color = TextSecondary, fontSize = 13.sp)
                        }
                    }
                } else {
                    val state = analysisState
                    val trend = state.tradingSignal?.entryContext ?: "NONE"
                    val signal = state.tradingSignal?.type ?: "HOLD"
                    val confidence = state.marketAnalysis?.confidenceScore ?: 0
                    val checkpoints = state.marketAnalysis?.conditionSummary ?: emptyList()
                    val indicators = state.marketAnalysis?.indicatorSummary ?: emptyList()
                    val engineHealth = state.engineStatus?.health ?: "UNKNOWN"

                    // Card 1: Live Engine Decision Pipeline & Confidence
                    GlowCard {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .semantics(mergeDescendants = true) {
                                    contentDescription = "Engine confidence $confidence percent. Signal $signal. Alignment $trend."
                                }
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column {
                                    Text("ENGINE CONFIDENCE", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                    Spacer(Modifier.height(4.dp))
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Box(modifier = Modifier.size(8.dp).background(ProfitGreen, RoundedCornerShape(4.dp)))
                                        Spacer(Modifier.width(6.dp))
                                        val engineStateDisplay = if (state.engineStatus?.state == "WAITING") "ACTIVE" else (state.engineStatus?.state ?: "UNKNOWN")
                                        Text(engineStateDisplay, color = ProfitGreen, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                                    }
                                }
                                Text("$confidence%", color = CyanPrimary, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp)
                            }

                            Spacer(Modifier.height(12.dp))

                            LinearProgressIndicator(
                                progress = { confidence / 100f },
                                modifier = Modifier.fillMaxWidth().height(6.dp),
                                color = if (confidence >= 80) ProfitGreen else CyanPrimary,
                                trackColor = NavyBorder
                            )

                            Spacer(Modifier.height(12.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                AnalysisBadge("ALIGNMENT", trend, if (trend == "LONG") ProfitGreen else if (trend == "SHORT") LossRed else TextSecondary)
                                AnalysisBadge("SIGNAL", signal, if (signal == "BUY") ProfitGreen else if (signal == "SELL") LossRed else TextPrimary)
                                AnalysisBadge("CONFIDENCE", "${confidence}%", CyanPrimary)
                            }
                        }
                    }

                    Spacer(Modifier.height(14.dp))

                    // Card 2: Technical Indicators (Direct Engine Output)
                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text("LIVE TECHNICAL INDICATORS", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            Spacer(Modifier.height(10.dp))
                            if (indicators.isEmpty()) {
                                Text("No indicators available.", color = TextSecondary, fontSize = 12.sp)
                            } else {
                                indicators.forEach { indicator ->
                                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Text(indicator.name, color = TextSecondary, fontSize = 12.sp)
                                        Text(indicator.value, color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
                                    }
                                    Spacer(Modifier.height(4.dp))
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(14.dp))

                    // Card 3: Strategy Checkpoints Checklist
                    if (checkpoints.isNotEmpty()) {
                        GlowCard {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Text("STRATEGY CHECKPOINTS", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                Spacer(Modifier.height(10.dp))
                                checkpoints.forEach { checkpoint ->
                                    Row(
                                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                                            val isMet = checkpoint.status == "PASSED"
                                            Icon(
                                                if (isMet) Icons.Default.CheckCircle else Icons.Default.Cancel,
                                                contentDescription = null,
                                                tint = if (isMet) ProfitGreen else TextMuted,
                                                modifier = Modifier.size(16.dp)
                                            )
                                            Spacer(Modifier.width(8.dp))
                                            Text(checkpoint.name, color = TextPrimary, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                                        }
                                        val isMet = checkpoint.status == "PASSED"
                                        Text(checkpoint.currentValue, color = if (isMet) ProfitGreen else TextSecondary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                    }
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(14.dp))

                    // Card 4: Engine Runtime Diagnostics
                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text("ENGINE RUNTIME DIAGNOSTICS", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            Spacer(Modifier.height(8.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Engine Health", color = TextSecondary, fontSize = 12.sp)
                                Text(engineHealth, color = if (engineHealth == "OK") ProfitGreen else LossRed, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            }
                            Spacer(Modifier.height(4.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Last Evaluation", color = TextSecondary, fontSize = 12.sp)
                                val formattedTime = state.engineStatus?.lastEvaluationTimestamp?.let {
                                    java.text.SimpleDateFormat("dd MMM, HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date(it))
                                } ?: "N/A"
                                Text(formattedTime, color = TextPrimary, fontSize = 12.sp)
                            }
                        }
                    }

                    Spacer(Modifier.height(40.dp))
                }
            }
        }
    }
}

@Composable
private fun AnalysisBadge(title: String, value: String, accentColor: Color) {
    Surface(
        color = NavyCard,
        shape = RoundedCornerShape(8.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, NavyBorder)
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(title, color = TextSecondary, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(2.dp))
            Text(value, color = accentColor, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }
    }
}

