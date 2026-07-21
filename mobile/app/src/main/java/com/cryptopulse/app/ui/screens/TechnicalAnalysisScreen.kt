package com.cryptopulse.app.ui.screens

import androidx.activity.ComponentActivity
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.compose.ui.platform.LocalContext
import com.cryptopulse.app.ui.strategies.TechnicalAnalysisViewModel
import com.cryptopulse.app.ui.components.CoinInfoCard
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.theme.*
import com.cryptopulse.app.service.BackgroundMonitoringService
import com.cryptopulse.app.data.api.Checkpoint
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TechnicalAnalysisScreen(
    candidate: MarketCandidate,
    strategy: String,
    onBack: () -> Unit,
    onBotActivated: () -> Unit = {},
    viewModel: ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
    technicalAnalysisViewModel: TechnicalAnalysisViewModel = hiltViewModel()
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    var isBotActive by remember { mutableStateOf(false) }
    var isLoading by remember { mutableStateOf(true) }
    var lastUpdated by remember { mutableStateOf(System.currentTimeMillis()) }

    val tradeSetupConfig by technicalAnalysisViewModel.tradeSetupConfig.collectAsState()
    val analysisResult by viewModel.technicalAnalysis.collectAsState(initial = null)
    val analysisError by viewModel.analysisError.collectAsState(initial = null)
    val botError by viewModel.botError.collectAsState(initial = null)
    val scope = rememberCoroutineScope()
    val appContext = LocalContext.current.applicationContext

    LaunchedEffect(strategy, candidate.symbol, tradeSetupConfig) {
        isLoading = true
        viewModel.fetchTechnicalAnalysis(strategy, tradeSetupConfig?.parameters)
        delay(10000)
        if (analysisResult == null) {
            isLoading = false
        }
    }

    LaunchedEffect(analysisResult) {
        if (analysisResult != null) {
            isLoading = false
        }
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
                                    viewModel.activateBot(candidate.symbol, strategy, tradeSetupConfig?.parameters)
                                    BackgroundMonitoringService.startService(appContext)
                                    onBotActivated()
                                } else {
                                    BackgroundMonitoringService.stopService(appContext)
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

                if (tradeSetupConfig != null) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = NavyCard),
                        border = androidx.compose.foundation.BorderStroke(1.dp, NavyBorder)
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(
                                "Trade Setup Configuration",
                                color = CyanPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                            Spacer(Modifier.height(8.dp))
                            tradeSetupConfig!!.parameters.forEach { (key, value) ->
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text(text = key, color = TextSecondary, fontSize = 13.sp)
                                    Text(text = value, color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                }

                if (analysisError != null && analysisResult == null) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(200.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(Icons.Default.WifiOff, null, tint = LossRed, modifier = Modifier.size(40.dp))
                            Spacer(Modifier.height(12.dp))
                            Text(analysisError ?: "Failed to run technical analysis.", color = TextSecondary, fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 32.dp))
                            Spacer(Modifier.height(16.dp))
                            GradientButton(
                                text = "Retry",
                                onClick = {
                                    viewModel.clearAnalysisError()
                                    viewModel.fetchTechnicalAnalysis(strategy, tradeSetupConfig?.parameters)
                                },
                                leadingIcon = Icons.Default.Refresh,
                                modifier = Modifier.fillMaxWidth(0.6f),
                                testTag = "technical_analysis_retry"
                            )
                        }
                    }
                } else if (isLoading) {
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
                    val result = analysisResult!!
                    val trend = result.signals["trend"] as? String ?: "NEUTRAL"
                    val strength = result.signals["strength"] as? String ?: "WEAK"
                    val recommendation = result.signals["recommendation"] as? String ?: "HOLD"
                    val confidence = (result.signals["confidence"] as? Number)?.toInt() ?: 0
                    val progress = result.progress
                    val checkpoints = result.checkpoints
                    val conditionsMet = result.conditionsMet
                    val opportunity = result.opportunity

                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column {
                                    Text(
                                        text = "Analysis Progress",
                                        color = TextPrimary,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 14.sp,
                                    )
                                    Spacer(Modifier.height(4.dp))
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Box(
                                            modifier = Modifier
                                                .size(8.dp)
                                                .background(ProfitGreen, shape = RoundedCornerShape(4.dp))
                                        )
                                        Spacer(Modifier.width(6.dp))
                                        Text(
                                            text = "Live",
                                            color = ProfitGreen,
                                            fontWeight = FontWeight.Bold,
                                            fontSize = 12.sp,
                                        )
                                    }
                                }
                                Column(horizontalAlignment = Alignment.End) {
                                    Text(
                                        text = "$progress%",
                                        color = CyanPrimary,
                                        fontWeight = FontWeight.ExtraBold,
                                        fontSize = 20.sp,
                                    )
                                    Text(
                                        text = "Conditions met: ${conditionsMet.size}/${checkpoints.size}",
                                        color = TextSecondary,
                                        fontSize = 11.sp,
                                    )
                                }
                            }

                            Spacer(Modifier.height(12.dp))

                            LinearProgressIndicator(
                                progress = { progress / 100f },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(6.dp),
                                color = if (progress >= 100) ProfitGreen else CyanPrimary,
                                trackColor = NavyBorder,
                            )

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
                            HorizontalDivider(thickness = 0.5.dp, color = NavyBorder)
                            Spacer(Modifier.height(10.dp))

                            Text(
                                text = "Confidence: $confidence%",
                                color = TextSecondary,
                                fontSize = 13.sp,
                            )

                            if (opportunity != null) {
                                Spacer(Modifier.height(8.dp))
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .background(ProfitGreen.copy(alpha = 0.1f), RoundedCornerShape(8.dp))
                                        .padding(8.dp),
                                ) {
                                    Icon(
                                        Icons.Default.CheckCircle,
                                        contentDescription = null,
                                        tint = ProfitGreen,
                                        modifier = Modifier.size(18.dp),
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        text = "Opportunity detected: ${opportunity["side"]} @ $${"%.2f".format(opportunity["entryPrice"] as? Double ?: 0.0)}",
                                        color = ProfitGreen,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 13.sp,
                                    )
                                }
                            }
                        }
                    }
                }

                Spacer(Modifier.height(14.dp))

                if (analysisResult != null) {
                    val checkpoints = analysisResult!!.checkpoints
                    if (checkpoints.isNotEmpty()) {
                        GlowCard {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Text(
                                    text = "STRATEGY CHECKPOINTS",
                                    color = TextPrimary,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.sp,
                                )
                                Spacer(Modifier.height(10.dp))
                                checkpoints.forEach { checkpoint ->
                                    CheckpointRow(checkpoint = checkpoint)
                                    if (checkpoint != checkpoints.last()) {
                                        Spacer(Modifier.height(4.dp))
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.height(14.dp))
                    }
                }

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
                                text = "The trading bot is monitoring ${candidate.pairName} using the $strategy strategy. Live updates are shown on the Live Analysis screen.",
                                color = TextSecondary,
                                fontSize = 11.sp,
                                lineHeight = 16.sp,
                            )
                        }
                    }
                }

                if (botError != null) {
                    Spacer(Modifier.height(12.dp))
                    GlowCard(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("technical_analysis_bot_error"),
                    ) {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(Icons.Default.Error, null, tint = LossRed, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(10.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text("Could not start the bot", color = LossRed, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                    Spacer(Modifier.height(2.dp))
                                    Text(botError ?: "Failed to activate the trading bot.", color = TextSecondary, fontSize = 11.sp, lineHeight = 16.sp)
                                }
                            }
                            Spacer(Modifier.height(12.dp))
                            GradientButton(
                                text = "Retry",
                                onClick = {
                                    viewModel.clearBotError()
                                    viewModel.activateBot(candidate.symbol, strategy, tradeSetupConfig?.parameters)
                                },
                                leadingIcon = Icons.Default.Refresh,
                                testTag = "technical_analysis_bot_retry"
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
private fun CheckpointRow(checkpoint: Checkpoint) {
    val statusColor = when (checkpoint.status) {
        "passed" -> ProfitGreen
        "failed" -> LossRed
        else -> TextMuted
    }
    val icon = when (checkpoint.status) {
        "passed" -> Icons.Default.CheckCircle
        "failed" -> Icons.Default.Cancel
        else -> Icons.Default.Schedule
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = statusColor,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(10.dp))
        Text(
            text = checkpoint.name,
            color = if (checkpoint.status == "pending") TextSecondary else TextPrimary,
            fontSize = 13.sp,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = checkpoint.status.uppercase(),
            color = statusColor,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
        )
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
