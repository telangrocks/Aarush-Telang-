package com.cryptopulse.app.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.theme.*
import com.cryptopulse.app.data.api.AnalysisStatusResponse
import com.cryptopulse.app.data.api.BotAlert
import com.cryptopulse.app.data.api.ScanCandidate
import com.cryptopulse.app.data.api.NearMatch
import com.cryptopulse.app.data.api.Checkpoint
import com.cryptopulse.app.data.api.TimeframeAnalysis
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveAnalysisScreen(
    onStopBot: () -> Unit,
    onOpportunity: (BotAlert) -> Unit = {},
    onBack: () -> Unit = {},
    viewModel: LiveAnalysisViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    val analysisState by viewModel.analysisState.collectAsState(initial = null)
    val isLoading by viewModel.isLoading.collectAsState()
    val error by viewModel.error.collectAsState()
    val pendingAlert by viewModel.pendingAlert.collectAsState()
    var isStopping by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        viewModel.startPolling()
    }

    // The analysis screen and the trade detection engine are one synchronized
    // workflow. The moment the backend raises a genuine opportunity (analysis
    // at 100%), surface the trade popup in lock-step with the engine.
    LaunchedEffect(pendingAlert) {
        pendingAlert?.let { alert ->
            if (alert.id.isNotEmpty()) {
                viewModel.clearPendingAlert()
                onOpportunity(alert)
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            viewModel.stopPolling()
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(bgGradient)) {
        Scaffold(
            topBar = {
                CryptoPulseTopBar(
                    onBack = if (isStopping) null else onBack
                )
            },
            containerColor = Color.Transparent,
            floatingActionButton = {
                if (analysisState?.isActive == true && !isStopping) {
                    ExtendedFloatingActionButton(
                        onClick = {
                            isStopping = true
                            viewModel.stopPolling()
                            onStopBot()
                        },
                        containerColor = LossRed,
                        contentColor = Color.White,
                        icon = { Icon(Icons.Default.Stop, contentDescription = "Stop Bot") },
                        text = { Text("STOP BOT", fontWeight = FontWeight.Bold, fontSize = 12.sp) },
                    )
                }
            },
        ) { padding ->
            if (isLoading && analysisState == null) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(color = CyanPrimary, strokeWidth = 3.dp)
                        Spacer(Modifier.height(16.dp))
                        Text("Initializing live analysis...", color = TextSecondary, fontSize = 14.sp)
                    }
                }
            } else if (error != null && analysisState == null) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Default.WifiOff, contentDescription = null, tint = LossRed, modifier = Modifier.size(48.dp))
                        Spacer(Modifier.height(16.dp))
                        Text(error ?: "Unknown error", color = TextSecondary, fontSize = 14.sp, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(12.dp))
                        Button(
                            onClick = { viewModel.startPolling() },
                            colors = ButtonDefaults.buttonColors(containerColor = CyanPrimary),
                        ) {
                            Text("Retry")
                        }
                    }
                }
            } else {
                val state = analysisState
                if (state == null || !state.isActive) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(padding),
                        contentAlignment = Alignment.Center
                    ) {
                        Text("Bot is not active.", color = TextSecondary, fontSize = 16.sp)
                    }
                } else {
                    LiveAnalysisContent(
                        state = state,
                        modifier = Modifier.padding(padding).testTag("live_analysis_root"),
                    )
                }
            }
        }
    }
}

@Composable
private fun LiveAnalysisContent(
    state: com.cryptopulse.app.data.api.AnalysisStatusResponse,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(top = 12.dp, bottom = 88.dp),
    ) {
        item {
            Text(
                text = "LIVE ANALYSIS",
                color = CyanPrimary,
                fontWeight = FontWeight.ExtraBold,
                fontSize = 18.sp,
                letterSpacing = 1.5.sp,
            )
        }

        item {
            ScanningProgressCard(
                progress = state.scanningProgress,
                etaSeconds = state.etaSeconds,
                strategy = state.strategy,
                coinId = state.coinId,
                exchange = state.exchange,
                environment = state.environment,
                confluenceScore = state.confluenceScore,
                alignment = state.alignment,
                primarySignal = state.primarySignal,
            )
        }

        item {
            CheckpointTimeline(checkpoints = state.checkpoints)
        }

        if (state.timeframes.isNotEmpty()) {
                item {
                    Text(
                        text = "MULTI-TIMEFRAME ANALYSIS",
                        color = TextSecondary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 12.sp,
                        letterSpacing = 1.sp,
                        modifier = Modifier.testTag("live_analysis_timeframes_header"),
                    )
                }
            item {
                TimeframeAnalysisGrid(timeframes = state.timeframes)
            }
        }

        if (state.coinsCurrentlyScanning.isNotEmpty()) {
            item {
                Text(
                    text = "SCANNING COINS",
                    color = TextSecondary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                    letterSpacing = 1.sp,
                )
            }
            item {
                CoinScannerRow(candidates = state.coinsCurrentlyScanning)
            }
        }

        if (state.nearMatches.isNotEmpty()) {
            item {
                Text(
                    text = "NEAR MATCHES",
                    color = ProfitGreen,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                    letterSpacing = 1.sp,
                )
            }
            items(state.nearMatches) { match ->
                NearMatchCard(match = match)
            }
        }

        item {
            Text(
                text = "LIVE LOGS",
                color = TextSecondary,
                fontWeight = FontWeight.Bold,
                fontSize = 12.sp,
                letterSpacing = 1.sp,
            )
        }
        item {
            LiveLogConsole(logs = state.logs)
        }
    }
}

@Composable
private fun ScanningProgressCard(
    progress: Int,
    etaSeconds: Int,
    strategy: String?,
    coinId: String?,
    exchange: String?,
    environment: String?,
    confluenceScore: Int,
    alignment: String,
    primarySignal: String,
) {
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
                        modifier = Modifier.testTag("live_analysis_progress_percent"),
                    )
                    Text(
                        text = "ETA ~${etaSeconds}s",
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
                    .height(6.dp)
                    .testTag("live_analysis_progress_bar"),
                color = CyanPrimary,
                trackColor = NavyBorder,
            )

            Spacer(Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                InfoChip(label = "Strategy", value = strategy ?: "N/A")
                InfoChip(label = "Primary Pair", value = coinId ?: "N/A")
                InfoChip(
                    label = "Exchange",
                    value = buildExchangeLabel(exchange, environment),
                )
            }

            Spacer(Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        text = "Confluence Score",
                        color = TextSecondary,
                        fontSize = 11.sp,
                    )
                    Text(
                        text = "$confluenceScore%",
                        color = when {
                            confluenceScore >= 75 -> ProfitGreen
                            confluenceScore >= 50 -> WarningOrange
                            else -> LossRed
                        },
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 18.sp,
                        modifier = Modifier.testTag("live_analysis_confluence_score"),
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "Alignment",
                        color = TextSecondary,
                        fontSize = 11.sp,
                    )
                    Text(
                        text = alignment,
                        color = when (alignment) {
                            "STRONG" -> ProfitGreen
                            "MODERATE" -> WarningOrange
                            else -> LossRed
                        },
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "Signal",
                        color = TextSecondary,
                        fontSize = 11.sp,
                    )
                    Text(
                        text = primarySignal,
                        color = when (primarySignal) {
                            "BUY" -> ProfitGreen
                            "SELL" -> LossRed
                            else -> TextSecondary
                        },
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 16.sp,
                        modifier = Modifier.testTag("live_analysis_signal"),
                    )
                }
            }
        }
    }
}

@Composable
private fun InfoChip(label: String, value: String) {
    Column {
        Text(text = label, color = TextSecondary, fontSize = 10.sp, letterSpacing = 0.5.sp)
        Text(text = value, color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
    }
}

private fun buildExchangeLabel(exchange: String?, environment: String?): String {
    val name = when (exchange?.lowercase()) {
        "binance" -> "Binance"
        "delta" -> "Delta"
        "bybit" -> "Bybit"
        else -> exchange ?: "N/A"
    }
    val env = if (environment?.lowercase() == "testnet") "Testnet" else "Mainnet"
    return "$name · $env"
}

@Composable
private fun TimeframeAnalysisGrid(timeframes: List<com.cryptopulse.app.data.api.TimeframeAnalysis>) {
    GlowCard {
        Column(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = "Timeframe Confluence",
                color = TextPrimary,
                fontWeight = FontWeight.Bold,
                fontSize = 13.sp,
            )
            Spacer(Modifier.height(10.dp))

            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(vertical = 4.dp),
            ) {
                items(timeframes) { tf ->
                    TimeframeCard(tf = tf)
                }
            }
        }
    }
}

@Composable
private fun TimeframeCard(tf: com.cryptopulse.app.data.api.TimeframeAnalysis) {
    val trendColor = when (tf.trend) {
        "BULLISH" -> ProfitGreen
        "BEARISH" -> LossRed
        else -> TextSecondary
    }
    val momentumColor = when (tf.momentum) {
        "OVERSOLD" -> WarningOrange
        "OVERBOUGHT" -> LossRed
        else -> TextSecondary
    }
    val signalColor = when {
        tf.trend == "BULLISH" && tf.momentum == "OVERSOLD" -> ProfitGreen
        tf.trend == "BEARISH" && tf.momentum == "OVERBOUGHT" -> LossRed
        else -> TextSecondary
    }

    Box(
        modifier = Modifier
            .width(150.dp)
            .background(NavyMid, RoundedCornerShape(12.dp))
            .border(1.dp, NavyBorder, RoundedCornerShape(12.dp))
            .padding(12.dp),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = tf.timeframe,
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp,
                )
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .background(signalColor, shape = RoundedCornerShape(4.dp))
                )
            }

            Spacer(Modifier.height(10.dp))
            HorizontalDivider(thickness = 0.5.dp, color = NavyBorder)
            Spacer(Modifier.height(10.dp))

            AnalysisRow("Trend", tf.trend, trendColor)
            AnalysisRow("Momentum", tf.momentum, momentumColor)
            AnalysisRow("EMA Cross", tf.emaCross, TextPrimary)
            AnalysisRow("Volume", tf.volumeProfile, TextPrimary)

            Spacer(Modifier.height(8.dp))
            HorizontalDivider(thickness = 0.5.dp, color = NavyBorder)
            Spacer(Modifier.height(8.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "RSI",
                    color = TextSecondary,
                    fontSize = 11.sp,
                )
                Text(
                    text = String.format("%.1f", tf.rsi),
                    color = when {
                        tf.rsi > 70 -> LossRed
                        tf.rsi < 30 -> ProfitGreen
                        else -> TextPrimary
                    },
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                )
            }

            Spacer(Modifier.height(4.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Confidence",
                    color = TextSecondary,
                    fontSize = 11.sp,
                )
                Text(
                    text = "${tf.confidence}%",
                    color = when {
                        tf.confidence >= 75 -> ProfitGreen
                        tf.confidence >= 50 -> WarningOrange
                        else -> LossRed
                    },
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 12.sp,
                )
            }

            if (tf.reasoning.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    text = tf.reasoning.first(),
                    color = TextMuted,
                    fontSize = 10.sp,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun AnalysisRow(label: String, value: String, valueColor: Color) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            color = TextMuted,
            fontSize = 11.sp,
        )
        Text(
            text = value,
            color = valueColor,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun CheckpointTimeline(checkpoints: List<com.cryptopulse.app.data.api.Checkpoint>) {
    GlowCard {
        Column(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = "Strategy Checkpoints",
                color = TextPrimary,
                fontWeight = FontWeight.Bold,
                fontSize = 13.sp,
            )
            Spacer(Modifier.height(10.dp))
            checkpoints.forEach { checkpoint ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val color = when (checkpoint.status) {
                        "passed" -> ProfitGreen
                        "failed" -> LossRed
                        else -> TextMuted
                    }
                    Icon(
                        imageVector = when (checkpoint.status) {
                            "passed" -> Icons.Default.CheckCircle
                            "failed" -> Icons.Default.Cancel
                            else -> Icons.Default.Schedule
                        },
                        contentDescription = null,
                        tint = color,
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
                        color = color,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
                if (checkpoint != checkpoints.last()) {
                    Spacer(Modifier.height(2.dp))
                }
            }
        }
    }
}

@Composable
private fun CoinScannerRow(candidates: List<ScanCandidate>) {
    GlowCard {
        Column(modifier = Modifier.fillMaxWidth()) {
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(vertical = 4.dp),
            ) {
                items(candidates) { candidate: ScanCandidate ->
                    CoinScanCard(candidate = candidate)
                }
            }
        }
    }
}

@Composable
private fun CoinScanCard(candidate: ScanCandidate) {
    val statusColor = when (candidate.status) {
        "scanning" -> CyanPrimary
        "queued" -> WarningOrange
        "rejected" -> LossRed
        else -> TextSecondary
    }

    Box(
        modifier = Modifier
            .width(140.dp)
            .background(NavyMid, RoundedCornerShape(12.dp))
            .border(1.dp, NavyBorder, RoundedCornerShape(12.dp))
            .padding(12.dp),
    ) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .background(statusColor, shape = RoundedCornerShape(4.dp))
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = candidate.symbol,
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp,
                )
            }
            Spacer(Modifier.height(8.dp))
            Text(
                text = "$${"%.2f".format(candidate.price)}",
                color = TextPrimary,
                fontWeight = FontWeight.SemiBold,
                fontSize = 14.sp,
            )
            Spacer(Modifier.height(8.dp))
            LinearProgressIndicator(
                progress = { candidate.progress / 100f },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(4.dp),
                color = statusColor,
                trackColor = NavyBorder,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = "${candidate.progress}%",
                color = TextSecondary,
                fontSize = 10.sp,
                modifier = Modifier.align(Alignment.End),
            )
        }
    }
}

@Composable
private fun NearMatchCard(match: com.cryptopulse.app.data.api.NearMatch) {
    GlowCard {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        text = match.symbol,
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp,
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = "Entry: $${"%.2f".format(match.estimatedEntry)}",
                        color = TextSecondary,
                        fontSize = 12.sp,
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "${match.confidence}%",
                        color = ProfitGreen,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 18.sp,
                    )
                    Text(
                        text = "Confidence",
                        color = TextSecondary,
                        fontSize = 10.sp,
                    )
                }
            }

            Spacer(Modifier.height(10.dp))
                        HorizontalDivider(thickness = 0.5.dp, color = NavyBorder)
            Spacer(Modifier.height(10.dp))

            Text(
                text = "Conditions Met",
                color = TextSecondary,
                fontWeight = FontWeight.Bold,
                fontSize = 11.sp,
                letterSpacing = 0.5.sp,
            )
            Spacer(Modifier.height(6.dp))

            match.conditionsMet.forEach { condition ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Default.Check,
                        contentDescription = null,
                        tint = ProfitGreen,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = condition,
                        color = TextPrimary,
                        fontSize = 13.sp,
                    )
                }
                Spacer(Modifier.height(4.dp))
            }
        }
    }
}

@Composable
private fun LiveLogConsole(logs: List<com.cryptopulse.app.data.api.AnalysisLog>) {
    GlowCard {
        Column(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = "Trade Logs",
                color = TextPrimary,
                fontWeight = FontWeight.Bold,
                fontSize = 13.sp,
            )
            Spacer(Modifier.height(8.dp))

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(180.dp)
                    .background(NavyDeep, RoundedCornerShape(8.dp))
                    .border(1.dp, NavyBorder, RoundedCornerShape(8.dp))
                    .padding(8.dp),
            ) {
                LazyColumn(
                    reverseLayout = true,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    items(logs.reversed()) { log ->
                        LogEntry(log = log)
                    }
                }
            }
        }
    }
}

@Composable
private fun LogEntry(log: com.cryptopulse.app.data.api.AnalysisLog) {
    val levelColor = when (log.level) {
        "accepted" -> ProfitGreen
        "rejected" -> LossRed
        "scanning" -> WarningOrange
        else -> CyanPrimary
    }
    val levelIcon = when (log.level) {
        "accepted" -> Icons.Default.CheckCircle
        "rejected" -> Icons.Default.Cancel
        "scanning" -> Icons.Default.Search
        else -> Icons.Default.Info
    }

    Row(verticalAlignment = Alignment.Top) {
        Icon(
            imageVector = levelIcon,
            contentDescription = null,
            tint = levelColor,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(6.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = log.message,
                color = TextPrimary,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = log.timestamp.replace("T", " ").take(19),
                color = TextMuted,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}


