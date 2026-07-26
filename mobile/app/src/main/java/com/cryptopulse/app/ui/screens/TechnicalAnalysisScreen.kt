package com.cryptopulse.app.ui.screens

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
import com.cryptopulse.app.domain.models.AnalysisSnapshot
import com.cryptopulse.app.domain.models.BotState
import com.cryptopulse.app.ui.components.CoinInfoCard
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.theme.*

import com.cryptopulse.app.ui.components.GradientButton

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TechnicalAnalysisScreen(
    candidate: MarketCandidate,
    analysisState: AnalysisSnapshot?,
    onBack: () -> Unit,
    onExecuteMockTrade: (Map<String, Any>) -> Unit
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

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
                            val currentPrice = if (candidate.currentMarketPrice > 0.0) candidate.currentMarketPrice else 50000.0
                            val mockAlert = mapOf<String, Any>(
                                "id" to "mock-alert-${System.currentTimeMillis()}",
                                "symbol" to candidate.symbol,
                                "side" to "BUY",
                                "entryPrice" to currentPrice,
                                "stopLoss" to (currentPrice * 0.985),
                                "takeProfit" to (currentPrice * 1.03),
                                "signalPrice" to currentPrice,
                                "targetEntryPrice" to currentPrice,
                                "positionSize" to 500.0,
                                "estimatedPnl" to (500.0 * 0.03)
                            )
                            onExecuteMockTrade(mockAlert)
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
                Text(
                    text = "${candidate.pairName} • Live Engine State: ${analysisState?.botState ?: BotState.ANALYSING}",
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
                    val trend = state.decisionPipeline.alignment
                    val signal = state.decisionPipeline.primarySignal
                    val confidence = state.confidence
                    val checkpoints = state.checkpoints
                    val metrics = state.runtimeMetrics

                    // Card 1: Live Engine Decision Pipeline & Confidence
                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
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
                                        Text(state.botState.name, color = ProfitGreen, fontWeight = FontWeight.Bold, fontSize = 12.sp)
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
                                AnalysisBadge("CONFLUENCE", "${state.decisionPipeline.confluenceScore.toInt()}%", CyanPrimary)
                            }
                        }
                    }

                    Spacer(Modifier.height(14.dp))

                    // Card 2: Technical Indicators (Direct Engine Output)
                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text("LIVE TECHNICAL INDICATORS", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            Spacer(Modifier.height(10.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("RSI (14)", color = TextSecondary, fontSize = 12.sp)
                                Text("%.2f".format(state.indicators.rsi), color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
                            }
                            Spacer(Modifier.height(4.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("MACD / Signal", color = TextSecondary, fontSize = 12.sp)
                                Text("%.2f / %.2f".format(state.indicators.macd.macd, state.indicators.macd.signal), color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
                            }
                            Spacer(Modifier.height(4.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("EMA 20 / EMA 50", color = TextSecondary, fontSize = 12.sp)
                                Text("$${"%.2f".format(state.indicators.ema20)} / $${"%.2f".format(state.indicators.ema50)}", color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
                            }
                            Spacer(Modifier.height(4.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("ATR (14)", color = TextSecondary, fontSize = 12.sp)
                                Text("$${"%.2f".format(state.indicators.atr)}", color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
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
                                            Icon(
                                                if (checkpoint.isMet) Icons.Default.CheckCircle else Icons.Default.Cancel,
                                                contentDescription = null,
                                                tint = if (checkpoint.isMet) ProfitGreen else TextMuted,
                                                modifier = Modifier.size(16.dp)
                                            )
                                            Spacer(Modifier.width(8.dp))
                                            Text(checkpoint.name, color = TextPrimary, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                                        }
                                        Text(checkpoint.value, color = if (checkpoint.isMet) ProfitGreen else TextSecondary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
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
                                Text("Analysis Cycles", color = TextSecondary, fontSize = 12.sp)
                                Text("#${metrics.cycleNumber}", color = TextPrimary, fontSize = 12.sp)
                            }
                            Spacer(Modifier.height(4.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Uptime", color = TextSecondary, fontSize = 12.sp)
                                Text("${metrics.uptimeSeconds}s", color = TextPrimary, fontSize = 12.sp)
                            }
                            Spacer(Modifier.height(4.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Exchange Latency", color = TextSecondary, fontSize = 12.sp)
                                Text("${metrics.exchangeLatencyMs}ms", color = TextPrimary, fontSize = 12.sp)
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
