package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.domain.models.AnalysisSnapshot
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.StrategyCategory
import com.cryptopulse.app.domain.models.RiskLevel
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.LocalOnLogout
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.theme.*

private val STRATEGY_CLEAN_REGEX = Regex("[-_]")

private fun resolveShortStrategyName(strategyId: String?, displayName: String?): String {
    if (displayName != null && displayName.isNotBlank()) {
        val clean = displayName
            .replace(Regex("(?i)\\b(Trading\\s+Strategy|Strategy)\\b"), "")
            .trim()
        if (clean.isNotBlank()) return clean.uppercase()
    }
    return when ((strategyId ?: "").lowercase().replace(STRATEGY_CLEAN_REGEX, "")) {
        "scalperv2", "scalping", "scalper" -> "SCALPER V2"
        "momentum" -> "MOMENTUM"
        "breakout" -> "BREAKOUT"
        "meanreversion", "reversion" -> "MEAN REVERSION"
        "vwap" -> "VWAP"
        else -> (strategyId ?: "SCALPER V2").uppercase()
    }
}

private val DEFAULT_STRATEGIES = listOf(
    Strategy(id = "ScalperV2", name = "Scalper V2", description = "", category = StrategyCategory.SCALPING, riskLevel = RiskLevel.HIGH, schemaVersion = 1, requiredParameters = emptyList()),
    Strategy(id = "Momentum", name = "Momentum Strategy", description = "", category = StrategyCategory.TREND_FOLLOWING, riskLevel = RiskLevel.MEDIUM, schemaVersion = 1, requiredParameters = emptyList()),
    Strategy(id = "Breakout", name = "Breakout Strategy", description = "", category = StrategyCategory.BREAKOUT, riskLevel = RiskLevel.HIGH, schemaVersion = 1, requiredParameters = emptyList()),
    Strategy(id = "MeanReversion", name = "Mean Reversion Strategy", description = "", category = StrategyCategory.MEAN_REVERSION, riskLevel = RiskLevel.LOW, schemaVersion = 1, requiredParameters = emptyList()),
    Strategy(id = "VWAP", name = "VWAP Strategy", description = "", category = StrategyCategory.VWAP, riskLevel = RiskLevel.MEDIUM, schemaVersion = 1, requiredParameters = emptyList())
)

private fun formatEvaluationTime(timestamp: Long?): String {
    if (timestamp == null || timestamp <= 0L) return "N/A"
    return try {
        java.text.SimpleDateFormat("dd MMM, HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date(timestamp))
    } catch (_: Exception) {
        "N/A"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TechnicalAnalysisScreen(
    candidate: MarketCandidate,
    analysisState: AnalysisSnapshot?,
    tradeSetupConfig: TradeSetupConfig? = null,
    availableStrategies: List<Strategy> = emptyList(),
    activeStrategyId: String? = null,
    isBotActive: Boolean = false,
    committedStrategyId: String? = null,
    isLoading: Boolean = false,
    isActivating: Boolean = false,
    previewError: String? = null,
    onSelectStrategy: (String) -> Unit = {},
    onCommitStrategy: (String) -> Unit = {},
    onBack: () -> Unit,
    onExecuteTrade: () -> Unit,
    onRetry: () -> Unit = {},
    onLogout: (() -> Unit)? = null
) {
    val bgGradient = remember { Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020))) }
    var showLogoutDialog by remember { mutableStateOf(false) }

    val resolvedStrategyId = remember(activeStrategyId, analysisState?.strategyMetadata?.strategyId, analysisState?.engineStatus?.activeStrategy, tradeSetupConfig?.strategyId) {
        activeStrategyId
            ?: analysisState?.strategyMetadata?.strategyId
            ?: analysisState?.engineStatus?.activeStrategy
            ?: tradeSetupConfig?.strategyId
            ?: "ScalperV2"
    }

    val matchingStrategy = remember(availableStrategies, resolvedStrategyId) {
        availableStrategies.find { it.id.equals(resolvedStrategyId, ignoreCase = true) }
    }

    val activeStrategyDisplayName = remember(matchingStrategy, analysisState?.strategyMetadata?.displayName, resolvedStrategyId) {
        matchingStrategy?.name
            ?: analysisState?.strategyMetadata?.displayName
            ?: when (resolvedStrategyId.lowercase().replace(STRATEGY_CLEAN_REGEX, "")) {
                "scalperv2", "scalping", "scalper" -> "SCALPERV2"
                "momentum" -> "MOMENTUM"
                "breakout" -> "BREAKOUT"
                "meanreversion", "reversion" -> "MEAN REVERSION"
                "vwap" -> "VWAP"
                else -> resolvedStrategyId.uppercase()
            }
    }

    val shortStrategyDisplayName = remember(activeStrategyDisplayName, resolvedStrategyId) {
        resolveShortStrategyName(resolvedStrategyId, activeStrategyDisplayName)
    }

    val committedShortName = remember(committedStrategyId, availableStrategies) {
        val strat = availableStrategies.find { it.id.equals(committedStrategyId, ignoreCase = true) }
        resolveShortStrategyName(committedStrategyId, strat?.name)
    }

    var currentIstTime by remember {
        val sdf = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).apply {
            timeZone = java.util.TimeZone.getTimeZone("Asia/Kolkata")
        }
        mutableStateOf(sdf.format(java.util.Date()))
    }

    LaunchedEffect(Unit) {
        val sdf = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).apply {
            timeZone = java.util.TimeZone.getTimeZone("Asia/Kolkata")
        }
        while (true) {
            currentIstTime = sdf.format(java.util.Date())
            kotlinx.coroutines.delay(1000L)
        }
    }

    if (showLogoutDialog) {
        AlertDialog(
            onDismissRequest = { showLogoutDialog = false },
            title = {
                Text(
                    text = "Log Out of CryptoPulse?",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 18.sp
                )
            },
            text = {
                Text(
                    text = "This will deactivate the trading bot and end your active trading session.",
                    color = TextSecondary,
                    fontSize = 14.sp
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showLogoutDialog = false
                        onLogout?.invoke()
                    }
                ) {
                    Text("Log Out", color = LossRed, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { showLogoutDialog = false }
                ) {
                    Text("Cancel", color = TextSecondary)
                }
            },
            containerColor = NavyDark,
            titleContentColor = TextPrimary,
            textContentColor = TextSecondary
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgGradient)
    ) {
        Scaffold(
            topBar = {
                CryptoPulseTopBar(
                    onBack = onBack,
                    onLogout = if (onLogout != null) { { showLogoutDialog = true } } else LocalOnLogout.current
                )
            },
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
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .widthIn(max = 680.dp)
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            if (isBotActive) {
                                Surface(
                                    color = NavyDark,
                                    shape = RoundedCornerShape(14.dp),
                                    border = androidx.compose.foundation.BorderStroke(1.dp, ProfitGreen.copy(alpha = 0.6f)),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(min = 56.dp)
                                        .testTag("commit_and_start_bot_button")
                                ) {
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(horizontal = 16.dp, vertical = 14.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.Center
                                    ) {
                                        Box(
                                            modifier = Modifier
                                                .size(10.dp)
                                                .background(ProfitGreen, RoundedCornerShape(5.dp))
                                        )
                                        Spacer(Modifier.width(10.dp))
                                        Text(
                                            text = "● BOT ACTIVE • ${committedShortName.uppercase()}",
                                            color = ProfitGreen,
                                            fontWeight = FontWeight.Bold,
                                            fontSize = 14.sp,
                                            letterSpacing = 0.5.sp,
                                            textAlign = TextAlign.Center
                                        )
                                    }
                                }
                            } else {
                                GradientButton(
                                    text = if (isActivating) "STARTING BOT..." else "START BOT • ${shortStrategyDisplayName.uppercase()}",
                                    onClick = {
                                        onCommitStrategy(resolvedStrategyId)
                                    },
                                    enabled = !isActivating && !isLoading,
                                    isLoading = isActivating,
                                    testTag = "commit_and_start_bot_button"
                                )
                            }
                            GradientButton(
                                text = "EXECUTE TRADE",
                                onClick = {
                                    onExecuteTrade()
                                },
                                enabled = true,
                                leadingIcon = Icons.Default.Bolt,
                                testTag = "execute_trade_button"
                            )
                        }
                    }
                }
            }
        ) { padding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.TopCenter
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .widthIn(max = 680.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Spacer(Modifier.height(8.dp))

                    val primaryTf = remember(analysisState?.strategyMetadata?.primaryTimeframe, matchingStrategy) {
                    analysisState?.strategyMetadata?.primaryTimeframe
                        ?: matchingStrategy?.supportedTimeframes?.firstOrNull()
                        ?: "15m"
                }

                // ==========================================
                // STRATEGY EXPLORATION DROPDOWN & HEADER
                // ==========================================
                var isStrategyMenuExpanded by remember { mutableStateOf(false) }

                Box(modifier = Modifier.fillMaxWidth()) {
                    Surface(
                        color = NavyDeep.copy(alpha = 0.85f),
                        shape = RoundedCornerShape(8.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, CyanPrimary.copy(alpha = 0.5f)),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { isStrategyMenuExpanded = true }
                            .testTag("strategy_dropdown_trigger")
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 14.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    text = "STRATEGY: ",
                                    color = TextSecondary,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    letterSpacing = 0.5.sp
                                )
                                Text(
                                    text = activeStrategyDisplayName.uppercase(),
                                    color = CyanPrimary,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.ExtraBold,
                                    letterSpacing = 0.5.sp,
                                    modifier = Modifier.testTag("strategy_title")
                                )
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (isLoading) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(14.dp),
                                        strokeWidth = 1.5.dp,
                                        color = CyanPrimary
                                    )
                                    Spacer(Modifier.width(8.dp))
                                }
                                Icon(
                                    imageVector = if (isStrategyMenuExpanded) Icons.Default.ArrowDropUp else Icons.Default.ArrowDropDown,
                                    contentDescription = "Select Strategy",
                                    tint = CyanPrimary,
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                        }
                    }

                    DropdownMenu(
                        expanded = isStrategyMenuExpanded,
                        onDismissRequest = { isStrategyMenuExpanded = false },
                        modifier = Modifier
                            .background(NavyCard)
                            .border(0.5.dp, NavyBorder, RoundedCornerShape(8.dp))
                    ) {
                        val strategiesToDisplay = remember(availableStrategies) {
                            if (availableStrategies.isNotEmpty()) availableStrategies else DEFAULT_STRATEGIES
                        }

                        strategiesToDisplay.forEach { strat ->
                            val isSelected = strat.id.equals(resolvedStrategyId, ignoreCase = true)
                            val isCommittedAndActive = isBotActive && strat.id.equals(committedStrategyId, ignoreCase = true)
                            DropdownMenuItem(
                                text = {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            if (isSelected) {
                                                Icon(
                                                    imageVector = Icons.Default.Check,
                                                    contentDescription = "Selected",
                                                    tint = ProfitGreen,
                                                    modifier = Modifier.size(16.dp)
                                                )
                                                Spacer(Modifier.width(8.dp))
                                            } else {
                                                Spacer(Modifier.width(24.dp))
                                            }
                                            Text(
                                                text = strat.name,
                                                color = if (isSelected) CyanPrimary else TextPrimary,
                                                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                                                fontSize = 13.sp
                                            )
                                        }
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            if (isCommittedAndActive) {
                                                Surface(
                                                    color = ProfitGreen.copy(alpha = 0.2f),
                                                    shape = RoundedCornerShape(4.dp)
                                                ) {
                                                    Text(
                                                        text = "ACTIVE",
                                                        color = ProfitGreen,
                                                        fontSize = 10.sp,
                                                        fontWeight = FontWeight.ExtraBold,
                                                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp)
                                                    )
                                                }
                                                Spacer(Modifier.width(6.dp))
                                            }
                                            Text(
                                                text = "(${strat.riskLevel.name} Risk)",
                                                color = TextMuted,
                                                fontSize = 11.sp
                                            )
                                        }
                                    }
                                },
                                onClick = {
                                    isStrategyMenuExpanded = false
                                    if (!isSelected) {
                                        onSelectStrategy(strat.id)
                                    }
                                },
                                modifier = Modifier.testTag("strategy_item_${strat.id}")
                            )
                        }
                    }
                }

                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${candidate.pairName} • $primaryTf Primary Timeframe",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )

                if (isBotActive) {
                    Spacer(Modifier.height(10.dp))
                    val isPreviewingDifferentStrategy = !resolvedStrategyId.equals(committedStrategyId, ignoreCase = true)
                    if (isPreviewingDifferentStrategy) {
                        Surface(
                            color = WarningOrange.copy(alpha = 0.12f),
                            shape = RoundedCornerShape(8.dp),
                            border = androidx.compose.foundation.BorderStroke(1.dp, WarningOrange.copy(alpha = 0.4f)),
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("preview_active_distinction_indicator")
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 14.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.Center
                            ) {
                                Text(
                                    text = "PREVIEWING: ${shortStrategyDisplayName.uppercase()} • ACTIVE BOT: ${committedShortName.uppercase()}",
                                    color = WarningOrange,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    letterSpacing = 0.5.sp,
                                    textAlign = TextAlign.Center
                                )
                            }
                        }
                    } else {
                        Surface(
                            color = ProfitGreen.copy(alpha = 0.12f),
                            shape = RoundedCornerShape(8.dp),
                            border = androidx.compose.foundation.BorderStroke(1.dp, ProfitGreen.copy(alpha = 0.4f)),
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("active_bot_indicator")
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 14.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.Center
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .background(ProfitGreen, RoundedCornerShape(4.dp))
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = "● BOT ACTIVE",
                                    color = ProfitGreen,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.ExtraBold,
                                    letterSpacing = 0.5.sp
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = "•",
                                    color = TextMuted,
                                    fontSize = 12.sp
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = "Active Strategy: ${committedShortName.uppercase()}",
                                    color = TextPrimary,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(14.dp))

                if (previewError != null && analysisState == null) {
                    GlowCard {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(16.dp),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            Icon(
                                imageVector = Icons.Default.Warning,
                                contentDescription = "Error",
                                tint = LossRed,
                                modifier = Modifier.size(36.dp)
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = "Technical Analysis Unavailable",
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 15.sp
                            )
                            Spacer(Modifier.height(6.dp))
                            Text(
                                text = previewError,
                                color = TextSecondary,
                                fontSize = 12.sp,
                                textAlign = TextAlign.Center
                            )
                            Spacer(Modifier.height(14.dp))
                            Button(
                                onClick = onRetry,
                                colors = ButtonDefaults.buttonColors(containerColor = CyanPrimary)
                            ) {
                                Text("RETRY ANALYSIS", color = NavyDeep, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                } else if (analysisState == null) {
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
                    val signalType = state.tradingSignal?.type ?: "HOLD"
                    val strategyScore = state.marketAnalysis?.confidenceScore ?: 0
                    val checkpoints = state.marketAnalysis?.conditionSummary ?: emptyList()
                    val indicators = state.marketAnalysis?.indicatorSummary ?: emptyList()
                    val engineHealth = state.engineStatus?.health ?: "UNKNOWN"

                    val requiredScore = remember(state.strategyMetadata?.parameters, matchingStrategy?.requiredParameters) {
                        state.strategyMetadata?.parameters?.find { it.key == "min_confidence" }?.value?.replace("%", "")?.toIntOrNull()
                            ?: matchingStrategy?.requiredParameters?.find { it.key == "min_confidence" }?.defaultValue?.replace("%", "")?.toIntOrNull()
                            ?: 75
                    }
                    val isQualified = remember(signalType, strategyScore, requiredScore) {
                        signalType != "HOLD" && strategyScore >= requiredScore
                    }
                    val qualificationStatus = remember(isQualified, signalType) {
                        if (isQualified) "QUALIFIED (${signalType})" else "NOT MET"
                    }
                    val passedCheckpointsCount = remember(checkpoints) {
                        checkpoints.count { it.status == "PASSED" }
                    }
                    val allCheckpointsPassed = remember(checkpoints) {
                        checkpoints.isNotEmpty() && checkpoints.all { it.status == "PASSED" }
                    }

                    // ==========================================
                    // LAYER 1: STRATEGY SCORE
                    // ==========================================
                    GlowCard {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .semantics(mergeDescendants = true) {
                                    contentDescription = "Strategy score $strategyScore out of 100. Required $requiredScore. Entry qualification $qualificationStatus."
                                }
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "STRATEGY SCORE",
                                    color = TextSecondary,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 12.sp,
                                    letterSpacing = 1.sp
                                )
                                Text(
                                    text = "Required: $requiredScore",
                                    color = TextSecondary,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }

                            Spacer(Modifier.height(8.dp))

                            Text(
                                text = "$strategyScore / 100",
                                color = if (isQualified) ProfitGreen else CyanPrimary,
                                fontWeight = FontWeight.ExtraBold,
                                fontSize = 28.sp
                            )

                            Spacer(Modifier.height(10.dp))

                            LinearProgressIndicator(
                                progress = { (strategyScore / 100f).coerceIn(0f, 1f) },
                                modifier = Modifier.fillMaxWidth().height(6.dp),
                                color = if (isQualified) ProfitGreen else CyanPrimary,
                                trackColor = NavyBorder
                            )

                            Spacer(Modifier.height(12.dp))

                            Surface(
                                color = if (isQualified) ProfitGreen.copy(alpha = 0.15f) else WarningOrange.copy(alpha = 0.15f),
                                shape = RoundedCornerShape(6.dp),
                                border = androidx.compose.foundation.BorderStroke(
                                    1.dp,
                                    if (isQualified) ProfitGreen.copy(alpha = 0.4f) else WarningOrange.copy(alpha = 0.4f)
                                )
                            ) {
                                Text(
                                    text = "ENTRY QUALIFICATION: $qualificationStatus",
                                    color = if (isQualified) ProfitGreen else WarningOrange,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                                )
                            }
                        }
                    }

                    Spacer(Modifier.height(14.dp))

                    // ==========================================
                    // LAYER 2: STRATEGY INDICATORS
                    // ==========================================
                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "STRATEGY INDICATORS",
                                    color = TextPrimary,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.sp,
                                    letterSpacing = 0.5.sp
                                )
                                if (indicators.isNotEmpty()) {
                                    Text(
                                        text = "${indicators.size} Active",
                                        color = CyanPrimary,
                                        fontWeight = FontWeight.SemiBold,
                                        fontSize = 11.sp
                                    )
                                }
                            }
                            Spacer(Modifier.height(12.dp))
                            if (indicators.isEmpty()) {
                                Text("No indicators available for active strategy.", color = TextSecondary, fontSize = 12.sp)
                            } else {
                                LazyRow(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                                ) {
                                    itemsIndexed(
                                        items = indicators,
                                        key = { index, indicator -> "${indicator.name}_$index" }
                                    ) { _, indicator ->
                                        val signalColor = when (indicator.signal) {
                                            "BULLISH" -> ProfitGreen
                                            "BEARISH" -> LossRed
                                            else -> TextMuted
                                        }
                                        Surface(
                                            color = NavyDeep.copy(alpha = 0.6f),
                                            shape = RoundedCornerShape(8.dp),
                                            border = androidx.compose.foundation.BorderStroke(
                                                0.5.dp,
                                                when (indicator.signal) {
                                                    "BULLISH" -> ProfitGreen.copy(alpha = 0.35f)
                                                    "BEARISH" -> LossRed.copy(alpha = 0.35f)
                                                    else -> NavyBorder
                                                }
                                            ),
                                            modifier = Modifier.width(135.dp)
                                        ) {
                                            Column(
                                                modifier = Modifier
                                                    .fillMaxWidth()
                                                    .padding(10.dp),
                                                verticalArrangement = Arrangement.SpaceBetween
                                            ) {
                                                Text(
                                                    text = indicator.name,
                                                    color = TextSecondary,
                                                    fontSize = 11.sp,
                                                    fontWeight = FontWeight.Medium,
                                                    maxLines = 2
                                                )
                                                Spacer(Modifier.height(8.dp))
                                                Text(
                                                    text = indicator.value,
                                                    color = TextPrimary,
                                                    fontWeight = FontWeight.Bold,
                                                    fontSize = 13.sp,
                                                    maxLines = 2
                                                )
                                                Spacer(Modifier.height(8.dp))
                                                Surface(
                                                    color = signalColor.copy(alpha = 0.15f),
                                                    shape = RoundedCornerShape(4.dp)
                                                ) {
                                                    Text(
                                                        text = indicator.signal,
                                                        color = signalColor,
                                                        fontSize = 10.sp,
                                                        fontWeight = FontWeight.Bold,
                                                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(14.dp))

                    // ==========================================
                    // LAYER 3: STRATEGY CHECKPOINTS
                    // ==========================================
                    if (checkpoints.isNotEmpty()) {
                        GlowCard {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = "STRATEGY CHECKPOINTS",
                                        color = TextPrimary,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 13.sp,
                                        letterSpacing = 0.5.sp
                                    )
                                    Text(
                                        text = "$passedCheckpointsCount/${checkpoints.size} Passed",
                                        color = if (allCheckpointsPassed) ProfitGreen else WarningOrange,
                                        fontWeight = FontWeight.SemiBold,
                                        fontSize = 11.sp
                                    )
                                }
                                Spacer(Modifier.height(12.dp))
                                LazyRow(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                                ) {
                                    itemsIndexed(
                                        items = checkpoints,
                                        key = { index, checkpoint -> "${checkpoint.id.ifBlank { checkpoint.name }}_$index" }
                                    ) { _, checkpoint ->
                                        val isPassed = checkpoint.status == "PASSED"
                                        Surface(
                                            color = NavyDeep.copy(alpha = 0.6f),
                                            shape = RoundedCornerShape(8.dp),
                                            border = androidx.compose.foundation.BorderStroke(
                                                0.5.dp,
                                                if (isPassed) ProfitGreen.copy(alpha = 0.35f) else NavyBorder
                                            ),
                                            modifier = Modifier.width(220.dp)
                                        ) {
                                            Column(
                                                modifier = Modifier
                                                    .fillMaxWidth()
                                                    .padding(12.dp)
                                            ) {
                                                Row(
                                                    modifier = Modifier.fillMaxWidth(),
                                                    horizontalArrangement = Arrangement.SpaceBetween,
                                                    verticalAlignment = Alignment.CenterVertically
                                                ) {
                                                    Row(
                                                        modifier = Modifier.weight(1f),
                                                        verticalAlignment = Alignment.CenterVertically
                                                    ) {
                                                        Icon(
                                                            imageVector = if (isPassed) Icons.Default.CheckCircle else Icons.Default.Cancel,
                                                            contentDescription = null,
                                                            tint = if (isPassed) ProfitGreen else LossRed,
                                                            modifier = Modifier.size(14.dp)
                                                        )
                                                        Spacer(Modifier.width(6.dp))
                                                        Text(
                                                            text = checkpoint.name,
                                                            color = TextPrimary,
                                                            fontSize = 12.sp,
                                                            fontWeight = FontWeight.Bold,
                                                            maxLines = 1
                                                        )
                                                    }
                                                    Spacer(Modifier.width(6.dp))
                                                    Surface(
                                                        color = if (isPassed) ProfitGreen.copy(alpha = 0.2f) else LossRed.copy(alpha = 0.2f),
                                                        shape = RoundedCornerShape(4.dp)
                                                    ) {
                                                        Text(
                                                            text = if (isPassed) "PASS" else "FAIL",
                                                            color = if (isPassed) ProfitGreen else LossRed,
                                                            fontSize = 10.sp,
                                                            fontWeight = FontWeight.ExtraBold,
                                                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                                        )
                                                    }
                                                }
                                                Spacer(Modifier.height(8.dp))
                                                HorizontalDivider(color = NavyBorder.copy(alpha = 0.6f))
                                                Spacer(Modifier.height(8.dp))
                                                Text(
                                                    text = "Actual: ${checkpoint.currentValue}",
                                                    color = TextSecondary,
                                                    fontSize = 11.sp,
                                                    lineHeight = 15.sp
                                                )
                                                Spacer(Modifier.height(4.dp))
                                                Text(
                                                    text = "Required: ${checkpoint.targetValue}",
                                                    color = TextMuted,
                                                    fontSize = 11.sp,
                                                    lineHeight = 15.sp
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.height(14.dp))
                    }

                    // ==========================================
                    // SECONDARY COLLAPSED ENGINE DIAGNOSTICS
                    // ==========================================
                    var isDiagnosticsExpanded by remember { mutableStateOf(false) }
                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { isDiagnosticsExpanded = !isDiagnosticsExpanded },
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        imageVector = if (isDiagnosticsExpanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                                        contentDescription = "Toggle Diagnostics",
                                        tint = TextSecondary,
                                        modifier = Modifier.size(18.dp)
                                    )
                                    Spacer(Modifier.width(6.dp))
                                    Text(
                                        text = "ENGINE DIAGNOSTICS",
                                        color = TextSecondary,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 12.sp
                                    )
                                }
                                Text(
                                    text = "Health: $engineHealth",
                                    color = if (engineHealth == "OK") ProfitGreen else LossRed,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                            if (isDiagnosticsExpanded) {
                                Spacer(Modifier.height(10.dp))
                                HorizontalDivider(color = NavyBorder)
                                Spacer(Modifier.height(8.dp))
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text("Engine State", color = TextSecondary, fontSize = 11.sp)
                                    val engineStateDisplay = if (state.engineStatus?.state == "WAITING") "ACTIVE" else (state.engineStatus?.state ?: "UNKNOWN")
                                    Text(engineStateDisplay, color = TextPrimary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                                }
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text("Current Time (IST)", color = TextSecondary, fontSize = 11.sp)
                                    Text(currentIstTime, color = TextPrimary, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                                }
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text("Last Evaluation", color = TextSecondary, fontSize = 11.sp)
                                    val formattedTime = remember(state.engineStatus?.lastEvaluationTimestamp) {
                                        formatEvaluationTime(state.engineStatus?.lastEvaluationTimestamp)
                                    }
                                    Text(formattedTime, color = TextPrimary, fontSize = 11.sp)
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(48.dp))
                }
            }
        }
    }
}
}


