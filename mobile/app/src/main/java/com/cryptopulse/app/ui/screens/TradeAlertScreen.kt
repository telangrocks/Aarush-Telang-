package com.cryptopulse.app.ui.screens

import android.content.Context
import android.media.RingtoneManager
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
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
    viewModel: ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var isProcessing by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        val notification = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val ringtone = RingtoneManager.getRingtone(context, notification)
        ringtone.play()
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
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        GradientButton(
                            text = "Cancel",
                            onClick = {
                                scope.launch {
                                    viewModel.dismissCurrentAlert()
                                    onBack()
                                }
                            },
                            leadingIcon = Icons.Default.Close,
                            modifier = Modifier.weight(1f),
                            enabled = !isProcessing,
                        )
                        GradientButton(
                            text = "Trade",
                            onClick = {
                                isProcessing = true
                                scope.launch {
                                    viewModel.executeCurrentTrade()
                                    onTradeExecuted()
                                    isProcessing = false
                                }
                            },
                            leadingIcon = Icons.Default.Check,
                            modifier = Modifier.weight(1f),
                            enabled = !isProcessing,
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
                    modifier = Modifier.fillMaxWidth(),
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

                        SummaryRow("Pair", candidate.pairName, TextPrimary)
                        SummaryRow("Entry Price", "${"%.2f".format(entryPrice)} USDT", TextPrimary)
                        SummaryRow("Stop Loss", "${"%.2f".format(stopLossPrice)} USDT", LossRed)
                        SummaryRow("Take Profit", "${"%.2f".format(takeProfitPrice)} USDT", ProfitGreen)
                        val pnlSign = if (estimatedPnl >= 0) "+" else ""
                        val pnlColor = if (estimatedPnl >= 0) ProfitGreen else LossRed
                        SummaryRow("Est. P&L", "$pnlSign${"%.2f".format(estimatedPnl)} USDT", pnlColor)

                Spacer(Modifier.height(16.dp))
            }
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
