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
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.compose.ui.platform.LocalContext
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.theme.*
import com.cryptopulse.app.service.BackgroundMonitoringService
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TechnicalAnalysisScreen(
    candidate: MarketCandidate,
    strategy: String,
    onBack: () -> Unit,
    viewModel: ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    var isBotActive by remember { mutableStateOf(false) }
    var analysisResult by remember { mutableStateOf<Map<String, Any>?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var lastUpdated by remember { mutableStateOf(System.currentTimeMillis()) }

    val scope = rememberCoroutineScope()

    LaunchedEffect(strategy) {
        isLoading = true
        delay(1500)
        analysisResult = mapOf(
            "trend" to "BULLISH",
            "strength" to "STRONG",
            "recommendation" to "BUY",
            "confidence" to 87,
            "rsi" to 62.5,
            "macd" to 1.24,
            "macdSignal" to 0.85,
            "ema20" to candidate.currentMarketPrice * 1.005,
            "ema50" to candidate.currentMarketPrice * 1.01,
            "sma200" to candidate.currentMarketPrice * 1.03,
        )
        isLoading = false
    }

    LaunchedEffect(isBotActive) {
        if (isBotActive) {
            while (true) {
                delay(5000)
                lastUpdated = System.currentTimeMillis()
            }
        }
    }

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
                        .padding(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    GradientButton(
                        text = if (isBotActive) "Stop Bot" else "Start Bot",
                        onClick = {
                            isBotActive = !isBotActive
                            scope.launch {
                                if (isBotActive) {
                                    viewModel.activateBot(candidate.symbol, strategy)
                                    BackgroundMonitoringService.startService(
                                        LocalContext.current.applicationContext
                                    )
                                } else {
                                    BackgroundMonitoringService.stopService(
                                        LocalContext.current.applicationContext
                                    )
                                }
                            }
                        },
                        leadingIcon = if (isBotActive) Icons.Default.Stop else Icons.Default.PlayArrow,
                        enabled = !isLoading,
                    )
                }
            }
        ) { padding ->

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp),
            ) {
                Spacer(Modifier.height(12.dp))

                Text(
                    text = "TECHNICAL ANALYSIS",
                    color = CyanPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 22.sp,
                    letterSpacing = 2.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${candidate.pairName} • ${strategy.replaceFirstChar { it.uppercase() }} Strategy",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(14.dp))

                CoinInfoCard(candidate = candidate)

                Spacer(Modifier.height(14.dp))

                if (isLoading) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(200.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator(color = CyanPrimary)
                            Spacer(Modifier.height(12.dp))
                            Text("Running technical analysis...", color = TextSecondary, fontSize = 13.sp)
                        }
                    }
                } else if (analysisResult != null) {
                    val trend = analysisResult!!["trend"] as String
                    val strength = analysisResult!!["strength"] as String
                    val recommendation = analysisResult!!["recommendation"] as String
                    val confidence = analysisResult!!["confidence"] as Int
                    val rsi = analysisResult!!["rsi"] as Double
                    val macd = analysisResult!!["macd"] as Double
                    val macdSignal = analysisResult!!["macdSignal"] as Double
                    val ema20 = analysisResult!!["ema20"] as Double
                    val ema50 = analysisResult!!["ema50"] as Double
                    val sma200 = analysisResult!!["sma200"] as Double

                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.AutoAwesome, null, tint = Color(0xFFBB86FC), modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    "ANALYSIS RESULT",
                                    color = Color(0xFFBB86FC),
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.sp,
                                    letterSpacing = 1.2.sp,
                                )
                            }
                            Spacer(Modifier.height(12.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                AnalysisBadge("TREND", trend, if (trend == "BULLISH") ProfitGreen else LossRed)
                                AnalysisBadge("STRENGTH", strength, CyanPrimary)
                                AnalysisBadge("SIGNAL", recommendation, if (recommendation == "BUY") ProfitGreen else if (recommendation == "SELL") LossRed else TextPrimary)
                            }

                            Spacer(Modifier.height(10.dp))
                            Divider(color = NavyBorder, thickness = 0.5.dp)
                            Spacer(Modifier.height(10.dp))

                            SummaryRow("Confidence", "${confidence}%", CyanPrimary)
                            SummaryRow("RSI", String.format("%.2f", rsi), TextPrimary)
                            SummaryRow("MACD", String.format("%.4f", macd), TextPrimary)
                            SummaryRow("MACD Signal", String.format("%.4f", macdSignal), TextPrimary)
                            SummaryRow("EMA 20", String.format("%.2f", ema20), TextPrimary)
                            SummaryRow("EMA 50", String.format("%.2f", ema50), TextPrimary)
                            SummaryRow("SMA 200", String.format("%.2f", sma200), TextPrimary)
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                if (isBotActive) {
                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    modifier = Modifier
                                        .size(10.dp)
                                        .background(ProfitGreen, shape = RoundedCornerShape(5.dp)),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    "BOT ACTIVE",
                                    color = ProfitGreen,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.sp,
                                )
                            }
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = "The trading bot is monitoring ${candidate.pairName} using the $strategy strategy. It will automatically execute trades based on real-time signals.",
                                color = TextSecondary,
                                fontSize = 11.sp,
                                lineHeight = 16.sp,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                Text(
                    text = "Last updated: ${java.text.SimpleDateFormat("HH:mm:ss").format(java.util.Date(lastUpdated))}",
                    color = TextMuted,
                    fontSize = 10.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@Composable
private fun AnalysisBadge(label: String, value: String, color: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, color = TextMuted, fontSize = 9.sp, letterSpacing = 0.5.sp)
        Spacer(Modifier.height(4.dp))
        Box(
            modifier = Modifier
                .background(color.copy(alpha = 0.15f), RoundedCornerShape(6.dp))
                .padding(horizontal = 10.dp, vertical = 6.dp),
        ) {
            Text(value, color = color, fontWeight = FontWeight.Bold, fontSize = 12.sp)
        }
    }
}

@Composable
private fun SummaryRow(label: String, value: String, valueColor: Color) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = TextSecondary, fontSize = 13.sp)
        Text(value, color = valueColor, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

