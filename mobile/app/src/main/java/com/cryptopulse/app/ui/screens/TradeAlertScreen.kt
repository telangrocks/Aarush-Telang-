package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import com.cryptopulse.app.ui.components.CoinInfoCard

import android.content.Context
import android.media.RingtoneManager
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.components.TradeExecutionConfirmationCard
import com.cryptopulse.app.domain.models.ExecutionUiState
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.theme.*
import kotlinx.coroutines.launch

/**
 * Electric cyan horizontal lens flare divider matching the reference branding design.
 */
@Composable
private fun ElectricCyanFlareDivider(
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val cy = h / 2f
        val center = Offset(w / 2f, cy)

        // Soft ambient diffuse electric-blue / cyan flare
        drawOval(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color(0x8800E5FF),
                    Color(0x330077FE),
                    Color.Transparent
                ),
                center = center,
                radius = w * 0.35f
            ),
            topLeft = Offset(center.x - w * 0.35f, 0f),
            size = Size(w * 0.70f, h)
        )

        // Bright horizontal flare line tapering at ends
        drawLine(
            brush = Brush.horizontalGradient(
                colors = listOf(
                    Color.Transparent,
                    Color(0x4400B4FF),
                    Color(0xFF00E5FF),
                    Color.White,
                    Color(0xFF00E5FF),
                    Color(0x4400B4FF),
                    Color.Transparent
                )
            ),
            start = Offset(w * 0.05f, cy),
            end = Offset(w * 0.95f, cy),
            strokeWidth = 1.6.dp.toPx()
        )
    }
}

/**
 * Reusable cyber-styled card container with glowing cyan halo and gradient border.
 */
@Composable
private fun TradeAlertCardContainer(
    modifier: Modifier = Modifier,
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
            .padding(horizontal = 16.dp, vertical = 14.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            content = content
        )
    }
}

/**
 * Custom cyber-styled CTA button with vibrant blue-to-purple gradient.
 */
@Composable
private fun TradeAlertCyberButton(
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
                .padding(horizontal = 14.dp),
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
                    Spacer(Modifier.width(8.dp))
                } else if (leadingIcon != null) {
                    Icon(
                        imageVector = leadingIcon,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(18.dp)
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
fun TradeAlertScreen(
    onBack: () -> Unit,
    onTradeExecuted: () -> Unit,
    candidate: MarketCandidate,
    entryPrice: Double,
    stopLossPrice: Double,
    takeProfitPrice: Double,
    estimatedPnl: Double,
    signalPrice: Double = 0.0,
    targetEntryPrice: Double? = null,
    tradeAmountUsdt: Double = 0.0,
    viewModel: ExchangeViewModel = hiltViewModel(),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    val scope = rememberCoroutineScope()
    val executionState by viewModel.executionState.collectAsState()
    val tradeError by viewModel.tradeError.collectAsState(initial = null)
    val isUnknownState by viewModel.isUnknownState.collectAsState()

    val isExecuting = executionState is ExecutionUiState.Submitting || executionState is ExecutionUiState.AwaitingFill

    LaunchedEffect(candidate.pairName) {
        viewModel.startLiveTicker(candidate.pairName)
    }

    DisposableEffect(Unit) {
        onDispose {
            viewModel.stopLiveTicker()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgGradient)
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {},
                    navigationIcon = {
                        IconButton(onClick = {
                            if (executionState is ExecutionUiState.Filled || executionState is ExecutionUiState.Confirmed) {
                                viewModel.dismissExecutionConfirmation { onBack() }
                            } else {
                                viewModel.dismissCurrentAlert()
                                onBack()
                            }
                        }) {
                            Icon(
                                imageVector = Icons.Default.ArrowBack,
                                contentDescription = "Back",
                                tint = Color.White
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = Color.Transparent
                    )
                )
            },
            containerColor = Color.Transparent,
            bottomBar = {
                if (executionState !is ExecutionUiState.Filled && executionState !is ExecutionUiState.Confirmed) {
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
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                if (tradeError != null) {
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .background(LossRed.copy(alpha = 0.12f), RoundedCornerShape(10.dp))
                                            .border(1.dp, LossRed.copy(alpha = 0.4f), RoundedCornerShape(10.dp))
                                            .padding(10.dp)
                                            .testTag("trade_alert_error"),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Icon(Icons.Default.Error, null, tint = LossRed, modifier = Modifier.size(18.dp))
                                        Spacer(Modifier.width(10.dp))
                                        Text(
                                            tradeError ?: "Failed to execute trade.",
                                            color = LossRed,
                                            fontSize = 12.sp,
                                            lineHeight = 16.sp,
                                            modifier = Modifier.weight(1f)
                                        )
                                    }
                                    Spacer(Modifier.height(10.dp))
                                }
                                if (isUnknownState) {
                                    TradeAlertCyberButton(
                                        text = "Reconciling Order...",
                                        onClick = { /* Hard locked to prevent double-fire */ },
                                        leadingIcon = Icons.Default.Sync,
                                        modifier = Modifier.fillMaxWidth(),
                                        enabled = false,
                                        testTag = "trade_alert_reconciling_button",
                                    )
                                } else if (executionState is ExecutionUiState.AwaitingFill) {
                                    TradeAlertCyberButton(
                                        text = "Awaiting Exchange Fill...",
                                        onClick = { },
                                        leadingIcon = Icons.Default.Sync,
                                        modifier = Modifier.fillMaxWidth(),
                                        enabled = false,
                                        isLoading = true,
                                        testTag = "trade_alert_awaiting_fill_button",
                                    )
                                } else if (executionState is ExecutionUiState.Submitting) {
                                    TradeAlertCyberButton(
                                        text = "Submitting to Exchange...",
                                        onClick = { },
                                        leadingIcon = Icons.Default.Sync,
                                        modifier = Modifier.fillMaxWidth(),
                                        enabled = false,
                                        isLoading = true,
                                        testTag = "trade_alert_submitting_button",
                                    )
                                } else {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                                    ) {
                                        TradeAlertCyberButton(
                                            text = if (tradeError != null) "RETRY" else "CANCEL",
                                            onClick = {
                                                if (tradeError != null) {
                                                    viewModel.clearTradeError()
                                                    scope.launch {
                                                        viewModel.executeCurrentTrade()
                                                    }
                                                } else {
                                                    try {
                                                        com.cryptopulse.app.forensics.CidDiagnosticManager.logPopupAction(
                                                            alertId = candidate.opportunityId ?: candidate.symbol,
                                                            action = "DISMISSED"
                                                        )
                                                    } catch (_: Throwable) {}
                                                    viewModel.dismissCurrentAlert()
                                                    onBack()
                                                }
                                            },
                                            leadingIcon = if (tradeError != null) Icons.Default.Refresh else Icons.Default.Close,
                                            modifier = Modifier.weight(1f),
                                            enabled = !isExecuting,
                                            testTag = "trade_alert_cancel_button",
                                        )
                                        TradeAlertCyberButton(
                                            text = "TRADE",
                                            onClick = {
                                                try {
                                                    com.cryptopulse.app.forensics.CidDiagnosticManager.logPopupAction(
                                                        alertId = candidate.opportunityId ?: candidate.symbol,
                                                        action = "CONFIRMED"
                                                    )
                                                } catch (_: Throwable) {}
                                                viewModel.clearTradeError()
                                                scope.launch {
                                                    viewModel.executeCurrentTrade()
                                                }
                                            },
                                            leadingIcon = Icons.Default.Check,
                                            modifier = Modifier.weight(1f),
                                            enabled = !isExecuting,
                                            testTag = "trade_alert_trade_button",
                                        )
                                    }
                                }
                            }
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
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Spacer(Modifier.height(14.dp))

                    val isFilled = executionState is ExecutionUiState.Filled || executionState is ExecutionUiState.Confirmed

                    // 1. Heading: "TRADE EXECUTED AT BYBIT EXCHANGE" (when filled) or "TRADE DETECTED" (otherwise)
                    Text(
                        text = if (isFilled) {
                            buildAnnotatedString {
                                withStyle(SpanStyle(color = Color.White, fontWeight = FontWeight.ExtraBold)) {
                                    append("TRADE EXECUTED\n")
                                }
                                withStyle(SpanStyle(color = Color(0xFF00E5FF), fontWeight = FontWeight.ExtraBold)) {
                                    append("AT BYBIT EXCHANGE")
                                }
                            }
                        } else {
                            buildAnnotatedString {
                                withStyle(SpanStyle(color = Color.White, fontWeight = FontWeight.ExtraBold)) {
                                    append("TRADE ")
                                }
                                withStyle(SpanStyle(color = Color(0xFF00E5FF), fontWeight = FontWeight.ExtraBold)) {
                                    append("DETECTED")
                                }
                            }
                        },
                        fontSize = if (isFilled) 24.sp else 30.sp,
                        letterSpacing = if (isFilled) 1.5.sp else 2.sp,
                        lineHeight = if (isFilled) 30.sp else 36.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag(if (isFilled) "trade_confirmation_header" else "trade_alert_header")
                    )

                    Spacer(Modifier.height(10.dp))

                    // 2. Glowing Neon Heartbeat Pulse Divider
                    HeartbeatPulseDivider(
                        modifier = Modifier
                            .fillMaxWidth(0.65f)
                            .height(22.dp)
                    )

                    Spacer(Modifier.height(12.dp))

                    // 3. Creator Attribution: "FOUNDED & BUILT BY" + "Shrikant Telang"
                    Text(
                        text = "FOUNDED & BUILT BY",
                        color = Color(0xFF8EA7C0),
                        fontSize = 10.5.sp,
                        letterSpacing = 3.sp,
                        fontWeight = FontWeight.Medium,
                        textAlign = TextAlign.Center
                    )

                    Spacer(Modifier.height(4.dp))

                    Text(
                        text = "Shrikant Telang",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        fontSize = 22.sp,
                        letterSpacing = 1.2.sp,
                        textAlign = TextAlign.Center
                    )

                    Spacer(Modifier.height(12.dp))

                    // 4. Electric Cyan Horizontal Lens Flare Divider
                    ElectricCyanFlareDivider(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(18.dp)
                    )

                    Spacer(Modifier.height(14.dp))

                    when (val state = executionState) {
                        is ExecutionUiState.Filled -> {
                            TradeExecutionConfirmationCard(
                                result = state.result,
                                onViewCandidates = {
                                    viewModel.dismissExecutionConfirmation { onTradeExecuted() }
                                },
                                onDismiss = {
                                    viewModel.dismissExecutionConfirmation { onBack() }
                                }
                            )
                        }
                        is ExecutionUiState.Confirmed -> {
                            TradeExecutionConfirmationCard(
                                result = state.result,
                                onViewCandidates = {
                                    viewModel.dismissExecutionConfirmation { onTradeExecuted() }
                                },
                                onDismiss = {
                                    viewModel.dismissExecutionConfirmation { onBack() }
                                }
                            )
                        }
                        is ExecutionUiState.AwaitingFill -> {
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 12.dp),
                                shape = RoundedCornerShape(16.dp),
                                colors = CardDefaults.cardColors(containerColor = NavyCard),
                                border = CardDefaults.outlinedCardBorder().copy(
                                    brush = Brush.horizontalGradient(listOf(CyanPrimary, ProfitGreen))
                                )
                            ) {
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(20.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally
                                ) {
                                    CircularProgressIndicator(
                                        color = CyanPrimary,
                                        modifier = Modifier.size(40.dp),
                                        strokeWidth = 3.dp
                                    )
                                    Spacer(Modifier.height(14.dp))
                                    Text(
                                        text = "Order Placed at Exchange",
                                        color = Color.White,
                                        fontSize = 16.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        text = "Awaiting fill confirmation for ${state.symbol} (${state.side})...",
                                        color = TextSecondary,
                                        fontSize = 12.sp,
                                        textAlign = TextAlign.Center
                                    )
                                }
                            }
                        }
                        is ExecutionUiState.Submitting -> {
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 12.dp),
                                shape = RoundedCornerShape(16.dp),
                                colors = CardDefaults.cardColors(containerColor = NavyCard)
                            ) {
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(20.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally
                                ) {
                                    CircularProgressIndicator(
                                        color = CyanPrimary,
                                        modifier = Modifier.size(36.dp),
                                        strokeWidth = 3.dp
                                    )
                                    Spacer(Modifier.height(12.dp))
                                    Text(
                                        text = "Submitting Order to Exchange...",
                                        color = Color.White,
                                        fontSize = 15.sp,
                                        fontWeight = FontWeight.SemiBold
                                    )
                                }
                            }
                        }
                        else -> {
                            // 5. Existing Trade Detection Data (occupying the space of the former coin bunch)
                            TradeAlertCardContainer {
                                // 1. Ticker Name
                                SummaryRow("Ticker Name", candidate.pairName, Color.White, "trade_alert_pair")
                                HorizontalDivider(color = Color(0x22142B47), thickness = 0.8.dp)

                                // 2. Entry Price
                                SummaryRow("Entry Price", "${formatPrice(entryPrice)} USDT", Color.White, "trade_alert_entry")
                                HorizontalDivider(color = Color(0x22142B47), thickness = 0.8.dp)

                                // 3. Stop Loss
                                SummaryRow("Stop Loss", "${formatPrice(stopLossPrice)} USDT", Color(0xFFFF3D57), "trade_alert_stop_loss")
                                HorizontalDivider(color = Color(0x22142B47), thickness = 0.8.dp)

                                // 4. Take Profit
                                SummaryRow("Take Profit", "${formatPrice(takeProfitPrice)} USDT", Color(0xFF00FFA3), "trade_alert_take_profit")
                                HorizontalDivider(color = Color(0x22142B47), thickness = 0.8.dp)

                                // 5. Estimated P&L
                                val pnlSign = if (estimatedPnl >= 0) "+" else ""
                                val pnlColor = if (estimatedPnl >= 0) Color(0xFF00FFA3) else Color(0xFFFF3D57)
                                SummaryRow("Estimated P&L", "$pnlSign${"%.2f".format(estimatedPnl)} USDT", pnlColor, "trade_alert_estimated_pnl")
                            }
                        }
                    }

                    Spacer(Modifier.height(32.dp))
                }
            }
        }
    }
}

private fun formatPrice(price: Double): String {
    return when {
        price <= 0.0 -> "0.00"
        price < 0.0001 -> "%.8f".format(price)
        price < 0.01 -> "%.6f".format(price)
        price < 1.0 -> "%.4f".format(price)
        price < 10.0 -> "%.3f".format(price)
        else -> "%.2f".format(price)
    }
}

@Composable
private fun SummaryRow(label: String, value: String, valueColor: Color, testTag: String? = null) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 7.dp)
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            color = Color(0xFF94B0D0),
            fontSize = 13.5.sp,
            fontWeight = FontWeight.Normal
        )
        Text(
            text = value,
            color = valueColor,
            fontSize = 13.5.sp,
            fontWeight = FontWeight.Bold,
            style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
        )
    }
}




