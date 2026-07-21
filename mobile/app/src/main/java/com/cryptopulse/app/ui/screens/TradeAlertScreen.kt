package com.cryptopulse.app.ui.screens

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
    signalPrice: Double,
    targetEntryPrice: Double? = null,
    viewModel: ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var isProcessing by remember { mutableStateOf(false) }
    val tradeError by viewModel.tradeError.collectAsState(initial = null)
    val lastTrade by viewModel.lastTrade.collectAsState(initial = null)

    LaunchedEffect(Unit) {
        val notification = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val ringtone = RingtoneManager.getRingtone(context, notification)
        ringtone.play()
    }

    // Resolve the outcome of an in-flight trade execution: navigate forward on a
    // confirmed fill, or surface the error and re-enable the buttons on failure.
    LaunchedEffect(isProcessing, lastTrade, tradeError) {
        if (isProcessing) {
            when {
                lastTrade != null -> {
                    isProcessing = false
                    onTradeExecuted()
                }
                tradeError != null -> {
                    isProcessing = false
                }
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
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(NavyDeep)
                        .padding(horizontal = 20.dp, vertical = 12.dp),
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
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        GradientButton(
                            text = if (tradeError != null) "Retry" else "Cancel",
                            onClick = {
                                if (tradeError != null) {
                                    viewModel.clearTradeError()
                                    isProcessing = true
                                    scope.launch {
                                        viewModel.executeCurrentTrade()
                                    }
                                } else {
                                    scope.launch {
                                        viewModel.dismissCurrentAlert()
                                        onBack()
                                    }
                                }
                            },
                            leadingIcon = if (tradeError != null) Icons.Default.Refresh else Icons.Default.Close,
                            modifier = Modifier.weight(1f),
                            enabled = !isProcessing,
                            testTag = "trade_alert_cancel_button",
                        )
                        GradientButton(
                            text = "Trade",
                            onClick = {
                                viewModel.clearTradeError()
                                isProcessing = true
                                scope.launch {
                                    viewModel.executeCurrentTrade()
                                }
                            },
                            leadingIcon = Icons.Default.Check,
                            modifier = Modifier.weight(1f),
                            enabled = !isProcessing,
                            testTag = "trade_alert_trade_button",
                        )
                    }
                }
            }
        ) { padding ->

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(12.dp))

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

                if (candidate != null) {
                    CoinInfoCard(candidate = candidate)
                }

                Spacer(Modifier.height(14.dp))

                GlowCard {
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
                        Divider(color = NavyBorder, thickness = 0.5.dp)
                        Spacer(Modifier.height(10.dp))

                        SummaryRow("Pair", candidate.pairName, TextPrimary, "trade_alert_pair")
                        if (targetEntryPrice != null && targetEntryPrice > 0.0) {
                            SummaryRow("Planned Entry", "${"%.2f".format(targetEntryPrice)} USDT", TextPrimary, "trade_alert_target_entry")
                        }
                        SummaryRow("Signal Price", "${"%.2f".format(signalPrice)} USDT", TextPrimary, "trade_alert_signal_price")
                        SummaryRow("Entry Price", "${"%.2f".format(entryPrice)} USDT", TextPrimary, "trade_alert_entry")
                        SummaryRow("Stop Loss", "${"%.2f".format(stopLossPrice)} USDT", LossRed, "trade_alert_stop_loss")
                        SummaryRow("Take Profit", "${"%.2f".format(takeProfitPrice)} USDT", ProfitGreen, "trade_alert_take_profit")
                        val pnlSign = if (estimatedPnl >= 0) "+" else ""
                        val pnlColor = if (estimatedPnl >= 0) ProfitGreen else LossRed
                        SummaryRow("Est. P&L", "$pnlSign${"%.2f".format(estimatedPnl)} USDT", pnlColor)

                Spacer(Modifier.height(16.dp))
            }
        }
    }
    }
}
}

@Composable
private fun SummaryRow(label: String, value: String, valueColor: Color, testTag: String? = null) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = TextSecondary, fontSize = 13.sp)
        Text(value, color = valueColor, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}


