package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import com.cryptopulse.app.ui.components.CoinInfoCard

import android.content.Context
import android.media.RingtoneManager
import android.net.Uri
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
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
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
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var isProcessing by remember { mutableStateOf(false) }
    val executionState by viewModel.executionState.collectAsState()
    val tradeError by viewModel.tradeError.collectAsState(initial = null)
    val livePrice by viewModel.liveAlertPrice.collectAsState()
    val isUnknownState by viewModel.isUnknownState.collectAsState()

    val isExecuting = executionState is ExecutionUiState.Submitting || executionState is ExecutionUiState.AwaitingFill

    val slippagePercent = remember(livePrice, signalPrice) {
        if (livePrice != null && signalPrice > 0) {
            ((livePrice!! - signalPrice) / signalPrice) * 100
        } else null
    }

    LaunchedEffect(Unit) {
        viewModel.startLiveTicker(candidate.symbol)
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
            topBar = { CryptoPulseTopBar(onBack = {
                if (executionState is ExecutionUiState.Filled) {
                    viewModel.dismissExecutionConfirmation { onBack() }
                } else {
                    viewModel.dismissCurrentAlert()
                    onBack()
                }
            }) },
            containerColor = Color.Transparent,
            bottomBar = {
                if (executionState !is ExecutionUiState.Filled) {
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
                                    GradientButton(
                                        text = "Reconciling Order...",
                                        onClick = { /* Hard locked to prevent double-fire */ },
                                        leadingIcon = Icons.Default.Sync,
                                        modifier = Modifier.fillMaxWidth(),
                                        enabled = false,
                                        testTag = "trade_alert_reconciling_button",
                                    )
                                } else if (executionState is ExecutionUiState.AwaitingFill) {
                                    GradientButton(
                                        text = "Awaiting Exchange Fill...",
                                        onClick = { },
                                        leadingIcon = Icons.Default.Sync,
                                        modifier = Modifier.fillMaxWidth(),
                                        enabled = false,
                                        testTag = "trade_alert_awaiting_fill_button",
                                    )
                                } else if (executionState is ExecutionUiState.Submitting) {
                                    GradientButton(
                                        text = "Submitting to Exchange...",
                                        onClick = { },
                                        leadingIcon = Icons.Default.Sync,
                                        modifier = Modifier.fillMaxWidth(),
                                        enabled = false,
                                        testTag = "trade_alert_submitting_button",
                                    )
                                } else {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                                    ) {
                                        GradientButton(
                                            text = if (tradeError != null) "Retry" else "Cancel",
                                            onClick = {
                                                if (tradeError != null) {
                                                    viewModel.clearTradeError()
                                                    scope.launch {
                                                        viewModel.executeCurrentTrade()
                                                    }
                                                } else {
                                                    viewModel.dismissCurrentAlert()
                                                    onBack()
                                                }
                                            },
                                            leadingIcon = if (tradeError != null) Icons.Default.Refresh else Icons.Default.Close,
                                            modifier = Modifier.weight(1f),
                                            enabled = !isExecuting,
                                            testTag = "trade_alert_cancel_button",
                                        )
                                        GradientButton(
                                            text = "Trade",
                                            onClick = {
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
                    Spacer(Modifier.height(12.dp))

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
                            // Standard Trade Alert Details
                        }
                    }

                    if (executionState !is ExecutionUiState.Filled) {
                        Text(
                            text = "TRADE DETECTED!",
                            color = ProfitGreen,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 24.sp,
                            letterSpacing = 2.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().testTag("trade_alert_header"),
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = "A valid trading opportunity has been identified.",
                            color = TextSecondary,
                            fontSize = 12.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )

                        Spacer(Modifier.height(14.dp))
                    }

                    if (executionState !is ExecutionUiState.Filled) {
                        if (candidate != null) {
                            CoinInfoCard(candidate = candidate)
                        }

                        Spacer(Modifier.height(14.dp))

                        GlowCard(modifier = Modifier.fillMaxWidth()) {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Default.NotificationsActive, null, tint = Color(0xFFBB86FC), modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        "TRADE DETAILS",
                                        color = Color(0xFFBB86FC),
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 13.sp,
                                        letterSpacing = 1.2.sp,
                                    )
                                }
                                Spacer(Modifier.height(12.dp))
                                HorizontalDivider(color = NavyBorder, thickness = 0.5.dp)
                                Spacer(Modifier.height(10.dp))

                                SummaryRow("Pair", candidate.pairName, TextPrimary, "trade_alert_pair")
                                
                                livePrice?.let { lp ->
                                    val slippage = slippagePercent ?: 0.0
                                    val slippageColor = if (Math.abs(slippage) > 0.05) Color(0xFFFFA500) else ProfitGreen
                                    SummaryRow("Live Price", "${formatPrice(lp)} USDT", slippageColor, "trade_alert_live_price")
                                    if (Math.abs(slippage) > 0.05) {
                                        Text(
                                            "Slippage > 0.05%. Order will execute as IOC Limit.",
                                            color = slippageColor,
                                            fontSize = 11.sp,
                                            modifier = Modifier.padding(bottom = 8.dp)
                                        )
                                    }
                                }

                                if (targetEntryPrice != null && targetEntryPrice > 0.0) {
                                    SummaryRow("Planned Entry", "${formatPrice(targetEntryPrice)} USDT", TextPrimary, "trade_alert_target_entry")
                                }
                                if (tradeAmountUsdt > 0.0) {
                                    SummaryRow("Trade Amount", "${"%.2f".format(tradeAmountUsdt)} USDT", TextPrimary, "trade_alert_amount")
                                }
                                SummaryRow("Signal Price", "${formatPrice(signalPrice)} USDT", TextPrimary, "trade_alert_signal_price")
                                SummaryRow("Entry Price", "${formatPrice(entryPrice)} USDT", TextPrimary, "trade_alert_entry")
                                SummaryRow("Stop Loss", "${formatPrice(stopLossPrice)} USDT", LossRed, "trade_alert_stop_loss")
                                SummaryRow("Take Profit", "${formatPrice(takeProfitPrice)} USDT", ProfitGreen, "trade_alert_take_profit")
                                val pnlSign = if (estimatedPnl >= 0) "+" else ""
                                val pnlColor = if (estimatedPnl >= 0) ProfitGreen else LossRed
                                SummaryRow("Est. P&L", "$pnlSign${"%.2f".format(estimatedPnl)} USDT", pnlColor)

                                Spacer(Modifier.height(8.dp))
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
            .padding(vertical = 5.dp)
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, color = TextSecondary, fontSize = 13.sp)
        Text(
            value,
            color = valueColor,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
        )
    }
}




