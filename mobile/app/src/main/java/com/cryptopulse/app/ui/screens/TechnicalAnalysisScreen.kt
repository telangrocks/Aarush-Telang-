package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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
        val date = java.util.Date(timestamp)
        val day = java.text.SimpleDateFormat("dd", java.util.Locale.US).format(date)
        val month = java.text.SimpleDateFormat("MMM", java.util.Locale.US).format(date)
        val time = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(date)
        val monthDisplay = if (month.equals("Sep", ignoreCase = true)) "Sept" else month
        "$day $monthDisplay, $time"
    } catch (_: Exception) {
        "N/A"
    }
}

/**
 * Reusable cyber-styled card container with glowing cyan halo and gradient border.
 */
@Composable
private fun TechnicalAnalysisCardContainer(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    testTag: String? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    val cardRadius = 16.dp
    val borderBrush = Brush.verticalGradient(
        listOf(
            Color(0xFF00B4FF),
            Color(0xFF0077E6),
            Color(0xFF0044AA),
        )
    )

    Box(
        modifier = modifier
            .fillMaxWidth()
            .drawBehind {
                drawRoundRect(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color(0x3500B4FF),
                            Color(0x120066FF),
                            Color.Transparent
                        ),
                        center = Offset(size.width / 2f, size.height / 2f),
                        radius = size.width * 0.60f
                    ),
                    cornerRadius = CornerRadius(cardRadius.toPx() + 4.dp.toPx(), cardRadius.toPx() + 4.dp.toPx())
                )
            }
            .clip(RoundedCornerShape(cardRadius))
            .background(
                Brush.verticalGradient(
                    listOf(
                        Color(0xE6081426),
                        Color(0xF2050D1A)
                    )
                )
            )
            .border(
                width = 1.4.dp,
                brush = borderBrush,
                shape = RoundedCornerShape(cardRadius)
            )
            .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier)
            .padding(horizontal = 16.dp, vertical = 14.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            content = content
        )
    }
}

enum class MarketCondition(
    val label: String,
    val color: Color,
    val icon: androidx.compose.ui.graphics.vector.ImageVector
) {
    BULLISH("BULLISH", ProfitGreen, Icons.Default.TrendingUp),
    BEARISH("BEARISH", LossRed, Icons.Default.TrendingDown),
    SIDEWAYS("SIDEWAYS", Color(0xFFFFB300), Icons.Default.SyncAlt),
    CHOPPY("CHOPPY", Color(0xFFFF7043), Icons.Default.ShowChart),
    ANALYZING("ANALYZING...", Color(0xFF00E5FF), Icons.Default.HourglassEmpty)
}

private fun resolveMarketCondition(snapshot: AnalysisSnapshot?): MarketCondition {
    if (snapshot == null) return MarketCondition.ANALYZING
    val marketAnalysis = snapshot.marketAnalysis ?: return MarketCondition.ANALYZING
    val confidence = marketAnalysis.confidenceScore ?: 0
    val checkpoints = marketAnalysis.conditionSummary ?: emptyList()
    val indicators = marketAnalysis.indicatorSummary ?: emptyList()

    // 1. Guard against uninitialized cycle or insufficient data buffers
    val isInsufficientData = indicators.any {
        it.name.contains("Data Status", ignoreCase = true) && it.value.contains("Insufficient", ignoreCase = true)
    }
    val isPendingReasoning = marketAnalysis.confidenceExplanation?.any {
        it.contains("pending initial cycle", ignoreCase = true)
    } == true
    if (isInsufficientData || isPendingReasoning || (checkpoints.isEmpty() && indicators.isEmpty()) || confidence == 0) {
        return MarketCondition.ANALYZING
    }

    // 2. Checkpoint states from backend ConditionEngine
    val trendCheckpoint = checkpoints.find { it.name.contains("Trend Alignment", ignoreCase = true) }
    val momentumCheckpoint = checkpoints.find { it.name.contains("Momentum Filter", ignoreCase = true) }
    val volatilityCheckpoint = checkpoints.find { it.name.contains("Volatility Expansion", ignoreCase = true) }

    val trendPassed = trendCheckpoint?.status.equals("PASSED", ignoreCase = true)
    val trendFailed = trendCheckpoint?.status.equals("FAILED", ignoreCase = true)

    val momentumPassed = momentumCheckpoint?.status.equals("PASSED", ignoreCase = true)
    val momentumFailed = momentumCheckpoint?.status.equals("FAILED", ignoreCase = true)

    val isVolatilityExpanding = volatilityCheckpoint?.status.equals("PASSED", ignoreCase = true) ||
        volatilityCheckpoint?.currentValue?.contains("Expanding", ignoreCase = true) == true
    val isVolatilityContracting = volatilityCheckpoint?.status.equals("FAILED", ignoreCase = true) ||
        volatilityCheckpoint?.currentValue?.contains("Contracting", ignoreCase = true) == true

    // 3. Directional indicator signals (RSI & MACD)
    val macdIndicator = indicators.find { it.name.contains("MACD", ignoreCase = true) }
    val rsiIndicator = indicators.find { it.name.contains("RSI", ignoreCase = true) }

    val isMacdBullish = macdIndicator?.signal.equals("BULLISH", ignoreCase = true)
    val isMacdBearish = macdIndicator?.signal.equals("BEARISH", ignoreCase = true)
    val isMacdNeutral = macdIndicator?.signal.equals("NEUTRAL", ignoreCase = true)

    val isRsiBullish = rsiIndicator?.signal.equals("BULLISH", ignoreCase = true)
    val isRsiBearish = rsiIndicator?.signal.equals("BEARISH", ignoreCase = true)
    val isRsiNeutral = rsiIndicator?.signal.equals("NEUTRAL", ignoreCase = true)

    // 4. Factor contributions
    val factorContributions = snapshot.strategyMetadata?.factorContributions ?: emptyList()
    val trendFactor = factorContributions.find { it.factor.contains("Trend", ignoreCase = true) }
    val trendScore = trendFactor?.score ?: 50

    // 5. Authoritative Regime Classifications
    val hasDirectionalConflict = (trendPassed && isMacdBearish) ||
        (trendFailed && isMacdBullish) ||
        (trendPassed && momentumFailed && !isRsiBullish) ||
        (trendFailed && momentumPassed && !isRsiBearish)
    val isChoppy = isVolatilityExpanding && hasDirectionalConflict

    val isBullish = (trendPassed || trendScore >= 60) && (momentumPassed || isMacdBullish || isRsiBullish) && !isMacdBearish
    val isBearish = (trendFailed || trendScore <= 40) && (momentumFailed || isMacdBearish || isRsiBearish) && !isMacdBullish
    val isSideways = isVolatilityContracting && (isMacdNeutral || isRsiNeutral || (!isBullish && !isBearish))

    return when {
        isChoppy -> MarketCondition.CHOPPY
        isBullish -> MarketCondition.BULLISH
        isBearish -> MarketCondition.BEARISH
        isSideways -> MarketCondition.SIDEWAYS
        else -> MarketCondition.ANALYZING
    }
}

@Composable
private fun MarketConditionCard(
    analysisState: AnalysisSnapshot?,
    isLoading: Boolean,
    modifier: Modifier = Modifier
) {
    val condition = remember(analysisState, isLoading) {
        if (isLoading && analysisState == null) {
            MarketCondition.ANALYZING
        } else {
            resolveMarketCondition(analysisState)
        }
    }

    TechnicalAnalysisCardContainer(
        modifier = modifier.testTag("market_condition_card")
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "MARKET CONDITION",
                color = Color(0xFF7A94B8),
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .background(
                            if (condition == MarketCondition.ANALYZING) Color(0xFF00E5FF) else condition.color,
                            CircleShape
                        )
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = if (condition == MarketCondition.ANALYZING) "ANALYZING" else "REAL-TIME",
                    color = Color(0xFF6E8CAE),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.5.sp
                )
            }
        }

        Spacer(Modifier.height(10.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Start
        ) {
            Surface(
                color = condition.color.copy(alpha = 0.12f),
                shape = RoundedCornerShape(8.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, condition.color.copy(alpha = 0.5f))
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (condition == MarketCondition.ANALYZING) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                            color = condition.color
                        )
                    } else {
                        Icon(
                            imageVector = condition.icon,
                            contentDescription = condition.label,
                            tint = condition.color,
                            modifier = Modifier.size(16.dp)
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = condition.label,
                        color = condition.color,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.ExtraBold,
                        letterSpacing = 0.5.sp
                    )
                }
            }
        }
    }
}

/**
 * Custom cyber-styled CTA button with vibrant blue-to-purple gradient.
 */
@Composable
private fun TechnicalAnalysisCyberButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leadingIcon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    enabled: Boolean = true,
    isLoading: Boolean = false,
    testTag: String? = null,
) {
    val buttonGradient = Brush.horizontalGradient(
        listOf(
            Color(0xFF0091FF),
            Color(0xFFB526FF)
        )
    )

    Button(
        onClick = onClick,
        enabled = enabled && !isLoading,
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.Transparent,
            disabledContainerColor = Color.Transparent
        ),
        contentPadding = PaddingValues(0.dp),
        modifier = modifier
            .fillMaxWidth()
            .height(54.dp)
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier)
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    if (enabled) buttonGradient else Brush.horizontalGradient(listOf(Color(0xFF2A3040), Color(0xFF2A3040))),
                    RoundedCornerShape(14.dp)
                )
                .padding(horizontal = 16.dp),
            contentAlignment = Alignment.Center
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = Color.White
                    )
                    Spacer(Modifier.width(10.dp))
                } else if (leadingIcon != null) {
                    Icon(
                        imageVector = leadingIcon,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    text = text.uppercase(),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp,
                    letterSpacing = 0.5.sp,
                    textAlign = TextAlign.Center
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TechnicalAnalysisScreen(
    candidate: MarketCandidate,
    analysisState: AnalysisSnapshot?,
    tradeSetupConfig: TradeSetupConfig? = null,
    availableStrategies: List<Strategy> = emptyList(),
    viewedStrategyId: String? = null,
    selectedStrategyId: String? = null,
    activeStrategyId: String? = null,
    isBotActive: Boolean = false,
    committedStrategyId: String? = null,
    isLoading: Boolean = false,
    isActivating: Boolean = false,
    previewError: String? = null,
    activationError: String? = null,
    onClearActivationError: () -> Unit = {},
    onSelectStrategy: (String) -> Unit = {},
    onUseStrategy: (String) -> Unit = {},
    onCommitStrategy: (String) -> Unit = {},
    onDeactivateBot: () -> Unit = {},
    onBack: () -> Unit,
    onExecuteTrade: () -> Unit,
    onRetry: () -> Unit = {},
    onLogout: (() -> Unit)? = null
) {
    val bgGradient = remember { Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020))) }
    var showLogoutDialog by remember { mutableStateOf(false) }

    val resolvedViewedStrategyId = remember(viewedStrategyId, activeStrategyId, analysisState?.strategyMetadata?.strategyId, tradeSetupConfig?.strategyId) {
        viewedStrategyId
            ?: activeStrategyId
            ?: analysisState?.strategyMetadata?.strategyId
            ?: tradeSetupConfig?.strategyId
            ?: "ScalperV2"
    }

    val resolvedSelectedStrategyId = remember(selectedStrategyId, tradeSetupConfig?.strategyId) {
        selectedStrategyId
            ?: tradeSetupConfig?.strategyId
            ?: "ScalperV2"
    }

    val resolvedStrategyId = resolvedViewedStrategyId

    val matchingStrategy = remember(availableStrategies, resolvedViewedStrategyId) {
        availableStrategies.find { it.id.equals(resolvedViewedStrategyId, ignoreCase = true) }
    }

    val activeStrategyDisplayName = remember(matchingStrategy, analysisState?.strategyMetadata?.displayName, resolvedViewedStrategyId) {
        matchingStrategy?.name
            ?: analysisState?.strategyMetadata?.displayName
            ?: when (resolvedViewedStrategyId.lowercase().replace(STRATEGY_CLEAN_REGEX, "")) {
                "scalperv2", "scalping", "scalper" -> "SCALPER V2"
                "momentum" -> "MOMENTUM"
                "breakout" -> "BREAKOUT"
                "meanreversion", "reversion" -> "MEAN REVERSION"
                "vwap" -> "VWAP"
                else -> resolvedViewedStrategyId.uppercase()
            }
    }

    val shortStrategyDisplayName = remember(activeStrategyDisplayName, resolvedViewedStrategyId) {
        resolveShortStrategyName(resolvedViewedStrategyId, activeStrategyDisplayName)
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
                    color = Color.Transparent,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .navigationBarsPadding(),
                        contentAlignment = Alignment.Center
                    ) {
                        // Ambient cyan horizon flare at bottom
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(90.dp)
                                .align(Alignment.BottomCenter)
                                .drawBehind {
                                    drawOval(
                                        brush = Brush.radialGradient(
                                            colors = listOf(
                                                Color(0x7000B4FF),
                                                Color(0x300077FE),
                                                Color.Transparent
                                            ),
                                            center = Offset(size.width / 2f, size.height * 0.9f),
                                            radius = size.width * 0.45f
                                        )
                                    )
                                }
                        )

                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .widthIn(max = 680.dp)
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            if (!activationError.isNullOrBlank()) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .background(LossRed.copy(alpha = 0.12f), RoundedCornerShape(10.dp))
                                        .border(1.dp, LossRed.copy(alpha = 0.4f), RoundedCornerShape(10.dp))
                                        .padding(10.dp)
                                        .testTag("activation_error_banner"),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.Error,
                                        contentDescription = null,
                                        tint = LossRed,
                                        modifier = Modifier.size(18.dp)
                                    )
                                    Spacer(Modifier.width(10.dp))
                                    Text(
                                        text = activationError,
                                        color = LossRed,
                                        fontSize = 12.sp,
                                        lineHeight = 16.sp,
                                        modifier = Modifier.weight(1f)
                                    )
                                    IconButton(
                                        onClick = onClearActivationError,
                                        modifier = Modifier.size(24.dp)
                                    ) {
                                        Icon(
                                            imageVector = Icons.Default.Close,
                                            contentDescription = "Dismiss error",
                                            tint = LossRed,
                                            modifier = Modifier.size(16.dp)
                                        )
                                    }
                                }
                            }

                            val isViewingActiveBot = isBotActive && 
                                !committedStrategyId.isNullOrBlank() && 
                                resolvedViewedStrategyId.equals(committedStrategyId, ignoreCase = true)

                            if (isViewingActiveBot) {
                                Button(
                                    onClick = { onDeactivateBot() },
                                    enabled = !isActivating && !isLoading,
                                    shape = RoundedCornerShape(14.dp),
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = LossRed,
                                        disabledContainerColor = Color(0xFF2A3040)
                                    ),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(54.dp)
                                        .testTag("commit_and_start_bot_button")
                                ) {
                                    if (isActivating) {
                                        CircularProgressIndicator(
                                            modifier = Modifier.size(18.dp),
                                            strokeWidth = 2.dp,
                                            color = Color.White
                                        )
                                        Spacer(Modifier.width(10.dp))
                                    }
                                    Text(
                                        text = if (isActivating) "DEACTIVATING..." else "DEACTIVATE BOT",
                                        color = Color.White,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 15.sp,
                                        letterSpacing = 0.5.sp,
                                        textAlign = TextAlign.Center
                                    )
                                }
                            } else {
                                TechnicalAnalysisCyberButton(
                                    text = if (isActivating) "ACTIVATING BOT..." else "USE THIS STRATEGY",
                                    onClick = { onCommitStrategy(resolvedViewedStrategyId) },
                                    enabled = !isActivating,
                                    isLoading = isActivating,
                                    testTag = "commit_and_start_bot_button"
                                )
                            }

                            TechnicalAnalysisCyberButton(
                                text = "EXECUTE TRADE",
                                onClick = { onExecuteTrade() },
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
                    Spacer(Modifier.height(10.dp))

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
                        TechnicalAnalysisCardContainer(
                            onClick = if (!isActivating) { { isStrategyMenuExpanded = true } } else null,
                            testTag = "strategy_dropdown_trigger"
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.weight(1f, fill = false)
                                ) {
                                    Text(
                                        text = "STRATEGY: ",
                                        color = Color(0xFF7A94B8),
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Bold,
                                        letterSpacing = 0.5.sp
                                    )
                                    Text(
                                        text = activeStrategyDisplayName.uppercase(),
                                        color = Color(0xFF00E5FF),
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.ExtraBold,
                                        letterSpacing = 0.5.sp,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.testTag("strategy_title")
                                    )
                                }
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    if (isLoading) {
                                        CircularProgressIndicator(
                                            modifier = Modifier.size(14.dp),
                                            strokeWidth = 1.5.dp,
                                            color = Color(0xFF00E5FF)
                                        )
                                        Spacer(Modifier.width(8.dp))
                                    }
                                    Icon(
                                        imageVector = if (isStrategyMenuExpanded) Icons.Default.ArrowDropUp else Icons.Default.ArrowDropDown,
                                        contentDescription = "Select Strategy",
                                        tint = Color(0xFF00E5FF),
                                        modifier = Modifier.size(24.dp)
                                    )
                                }
                            }
                        }

                        DropdownMenu(
                            expanded = isStrategyMenuExpanded,
                            onDismissRequest = { isStrategyMenuExpanded = false },
                            modifier = Modifier
                                .background(Color(0xFF081426))
                                .border(1.dp, Color(0xFF0077E6), RoundedCornerShape(10.dp))
                        ) {
                            val strategiesToDisplay = remember(availableStrategies) {
                                if (availableStrategies.isNotEmpty()) availableStrategies else DEFAULT_STRATEGIES
                            }

                            strategiesToDisplay.forEach { strat ->
                                val isSelected = strat.id.equals(resolvedViewedStrategyId, ignoreCase = true)
                                val isCommittedAndActive = isBotActive && strat.id.equals(committedStrategyId, ignoreCase = true)
                                DropdownMenuItem(
                                    text = {
                                        Row(
                                            modifier = Modifier.fillMaxWidth(),
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                            verticalAlignment = Alignment.CenterVertically
                                        ) {
                                            Row(
                                                modifier = Modifier.weight(1f, fill = false),
                                                verticalAlignment = Alignment.CenterVertically
                                            ) {
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
                                                    fontSize = 13.sp,
                                                    maxLines = 1
                                                )
                                            }
                                            Spacer(Modifier.width(8.dp))
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

                    Spacer(Modifier.height(10.dp))

                    MarketConditionCard(
                        analysisState = analysisState,
                        isLoading = isLoading,
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(Modifier.height(12.dp))

                    if (previewError != null && analysisState == null) {
                        TechnicalAnalysisCardContainer {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(8.dp),
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
                                CircularProgressIndicator(color = Color(0xFF00B4FF))
                                Spacer(Modifier.height(12.dp))
                                Text("Connecting to backend trading engine...", color = Color(0xFF6E8CAE), fontSize = 13.sp)
                            }
                        }
                    } else {
                        val state = analysisState
                        val signalType = state.tradingSignal?.type
                        val strategyScore = state.marketAnalysis?.confidenceScore ?: 0
                        val checkpoints = state.marketAnalysis?.conditionSummary ?: emptyList()
                        val indicators = state.marketAnalysis?.indicatorSummary ?: emptyList()
                        val engineHealth = state.engineStatus?.health ?: "UNKNOWN"

                        val snapshotStrategyId = state.strategyMetadata?.strategyId ?: state.engineStatus?.activeStrategy
                        val isSnapshotForCurrentStrategy = snapshotStrategyId == null || 
                            snapshotStrategyId.equals(resolvedViewedStrategyId, ignoreCase = true)

                        val extractedScoreFromSnapshot = state.marketAnalysis?.requiredScore
                            ?: state.requiredScore
                            ?: state.strategyMetadata?.parameters?.find { 
                                it.key.equals("min_confidence", ignoreCase = true) ||
                                it.key.equals("minConfidence", ignoreCase = true) ||
                                it.key.equals("minConfidenceScore", ignoreCase = true) ||
                                it.key.equals("required_score", ignoreCase = true) ||
                                it.key.equals("requiredScore", ignoreCase = true) ||
                                it.label.contains("Confidence", ignoreCase = true) ||
                                it.label.contains("Required", ignoreCase = true)
                            }?.value?.replace("%", "")?.trim()?.toIntOrNull()

                        val extractedScoreFromSchema = matchingStrategy?.requiredParameters?.find {
                            it.key.equals("min_confidence", ignoreCase = true) ||
                            it.key.equals("minConfidence", ignoreCase = true) ||
                            it.key.equals("minConfidenceScore", ignoreCase = true) ||
                            it.key.equals("required_score", ignoreCase = true) ||
                            it.key.equals("requiredScore", ignoreCase = true) ||
                            it.displayName.contains("Confidence", ignoreCase = true) ||
                            it.displayName.contains("Required", ignoreCase = true)
                        }?.defaultValue?.replace("%", "")?.trim()?.toIntOrNull()

                        val strategyDefaultScore = when (resolvedViewedStrategyId.lowercase().replace(STRATEGY_CLEAN_REGEX, "")) {
                            "scalperv2", "scalping", "scalper" -> 75
                            "meanreversion", "reversion" -> 75
                            "momentum", "breakout", "vwap" -> 70
                            else -> 70
                        }

                        val requiredScore = if (isSnapshotForCurrentStrategy) {
                            extractedScoreFromSnapshot ?: extractedScoreFromSchema ?: strategyDefaultScore
                        } else {
                            extractedScoreFromSchema ?: strategyDefaultScore
                        }

                        val isQualified = (signalType == "BUY" || signalType == "SELL") && strategyScore >= requiredScore
                        val qualificationStatus = if (isQualified) "QUALIFIED ($signalType)" else "NOT MET"

                        // ==========================================
                        // CARD 2: STRATEGY SCORE & QUALIFICATION
                        // ==========================================
                        TechnicalAnalysisCardContainer(
                            modifier = Modifier.semantics(mergeDescendants = true) {
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
                                    color = Color(0xFF7A94B8),
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 12.sp,
                                    letterSpacing = 1.sp
                                )
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        text = "Required: ",
                                        color = Color(0xFF6E8CAE),
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Medium
                                    )
                                    Text(
                                        text = "$requiredScore",
                                        color = Color(0xFFE2E8F0),
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }

                            Spacer(Modifier.height(10.dp))

                            Text(
                                text = "$strategyScore / 100",
                                color = if (isQualified) Color(0xFF00FFA3) else Color(0xFF00E5FF),
                                fontWeight = FontWeight.ExtraBold,
                                fontSize = 32.sp
                            )

                            Spacer(Modifier.height(12.dp))

                            val clampedProgress = (strategyScore / 100f).coerceIn(0f, 1f)
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(8.dp)
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(Color(0xFF0F2038))
                            ) {
                                if (clampedProgress > 0f) {
                                    Box(
                                        modifier = Modifier
                                            .fillMaxHeight()
                                            .fillMaxWidth(fraction = clampedProgress)
                                            .clip(RoundedCornerShape(4.dp))
                                            .background(
                                                Brush.horizontalGradient(
                                                    listOf(
                                                        Color(0xFF00E5FF),
                                                        Color(0xFF00FFA3)
                                                    )
                                                )
                                            )
                                    )
                                }
                            }

                            Spacer(Modifier.height(14.dp))

                            val badgeBorderColor = if (isQualified) Color(0xFF00E676) else Color(0xFFFFAB40)
                            val badgeBgColor = if (isQualified) Color(0x1800E676) else Color(0x18FFAB40)
                            val badgeTextColor = if (isQualified) Color(0xFF00FFA3) else Color(0xFFFFAB40)

                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(badgeBgColor)
                                    .border(1.2.dp, badgeBorderColor, RoundedCornerShape(10.dp))
                                    .padding(horizontal = 12.dp, vertical = 10.dp)
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(20.dp)
                                            .border(1.5.dp, badgeBorderColor, CircleShape),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        Icon(
                                            imageVector = if (isQualified) Icons.Default.Check else Icons.Default.PriorityHigh,
                                            contentDescription = null,
                                            tint = badgeBorderColor,
                                            modifier = Modifier.size(13.dp)
                                        )
                                    }
                                    Spacer(Modifier.width(10.dp))
                                    Text(
                                        text = "ENTRY QUALIFICATION: $qualificationStatus",
                                        color = badgeTextColor,
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Bold,
                                        letterSpacing = 0.5.sp
                                    )
                                }
                            }
                        }

                        Spacer(Modifier.height(14.dp))

                        // Preserved logic structure (hidden from UI)
                        if (false) {
                            GlowCard {
                                Column(modifier = Modifier.fillMaxWidth()) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Text(text = "STRATEGY INDICATORS")
                                        Text(text = "${indicators.size} Active")
                                    }
                                    LazyRow {
                                        itemsIndexed(
                                            items = indicators,
                                            key = { index, indicator -> "${indicator.name}_$index" }
                                        ) { _, _ -> }
                                    }
                                    LazyRow {
                                        itemsIndexed(
                                            items = checkpoints,
                                            key = { index, checkpoint -> "${checkpoint.id.ifBlank { checkpoint.name }}_$index" }
                                        ) { _, _ -> }
                                    }
                                }
                            }
                        }

                        // ==========================================
                        // CARD 3: ENGINE DIAGNOSTICS (PERMANENTLY VISIBLE)
                        // ==========================================
                        TechnicalAnalysisCardContainer {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "ENGINE DIAGNOSTICS",
                                    color = Color(0xFF7A94B8),
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 12.sp,
                                    letterSpacing = 0.5.sp
                                )
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        text = "Health: ",
                                        color = Color(0xFF7A94B8),
                                        fontSize = 12.sp
                                    )
                                    Text(
                                        text = engineHealth,
                                        color = if (engineHealth == "OK") Color(0xFF00FFA3) else LossRed,
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }

                            Spacer(Modifier.height(10.dp))
                            HorizontalDivider(color = Color(0xFF142B47), thickness = 1.dp)
                            Spacer(Modifier.height(8.dp))

                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "Engine State",
                                    color = Color(0xFF6E8CAE),
                                    fontSize = 12.sp
                                )
                                val engineStateDisplay = if (state.engineStatus?.state == "WAITING") "ACTIVE" else (state.engineStatus?.state ?: "UNKNOWN")
                                Text(
                                    text = engineStateDisplay,
                                    color = Color.White,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold
                                )
                            }

                            HorizontalDivider(color = Color(0x22142B47), thickness = 1.dp)

                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "Current Time (IST)",
                                    color = Color(0xFF6E8CAE),
                                    fontSize = 12.sp
                                )
                                Text(
                                    text = currentIstTime,
                                    color = Color.White,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Medium
                                )
                            }

                            HorizontalDivider(color = Color(0x22142B47), thickness = 1.dp)

                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "Last Evaluation",
                                    color = Color(0xFF6E8CAE),
                                    fontSize = 12.sp
                                )
                                val formattedTime = remember(state.engineStatus?.lastEvaluationTimestamp) {
                                    formatEvaluationTime(state.engineStatus?.lastEvaluationTimestamp)
                                }
                                Text(
                                    text = formattedTime,
                                    color = Color.White,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Normal
                                )
                            }
                        }

                        Spacer(Modifier.height(16.dp))

                        // Ambient Horizon Glow Streak
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(1.5.dp)
                                .background(
                                    Brush.horizontalGradient(
                                        listOf(
                                            Color.Transparent,
                                            Color(0x5000B4FF),
                                            Color(0x9000E5FF),
                                            Color(0x5000B4FF),
                                            Color.Transparent
                                        )
                                    )
                                )
                        )

                        Spacer(Modifier.height(24.dp))
                    }
                }
            }
        }
    }
}


