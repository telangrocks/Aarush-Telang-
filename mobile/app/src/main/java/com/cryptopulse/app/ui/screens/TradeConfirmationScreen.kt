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
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.theme.*
import kotlinx.coroutines.launch

@Composable
fun TradeConfirmationScreen(
    candidate: MarketCandidate,
    entryPrice: Double,
    stopLossPrice: Double,
    takeProfitPrice: Double,
    positionSize: Double,
    onBack: () -> Unit,
    viewModel: ExchangeViewModel = hiltViewModel(),
    onConfirmTrade: () -> Unit = {},
) {
    val stopLossPct    = if (entryPrice > 0) abs((stopLossPrice - entryPrice) / entryPrice * 100) else 0.0
    val takeProfitPct  = if (entryPrice > 0) abs((takeProfitPrice - entryPrice) / entryPrice * 100) else 0.0
    val rrRatio        = if (stopLossPct > 0) "1 : ${"%.2f".format(takeProfitPct / stopLossPct)}" else "–"
    val potentialProfit= (takeProfitPrice - entryPrice) / entryPrice * positionSize
    val potentialLoss  = (entryPrice - stopLossPrice) / entryPrice * positionSize
    val estimatedPnl   = potentialProfit

    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    val scope = rememberCoroutineScope()
    var isLoading by remember { mutableStateOf(false) }

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
                    GradientButton(
                        text = if (isLoading) "Processing..." else "Confirm Trade",
                        onClick = {
                            if (!isLoading) {
                                isLoading = true
                                scope.launch {
                                    viewModel.fetchTechnicalAnalysis()
                                    onConfirmTrade()
                                    isLoading = false
                                }
                            }
                        },
                        leadingIcon = if (isLoading) Icons.Default.HourglassEmpty else Icons.Default.Shield,
                        trailingIcon = if (!isLoading) Icons.Default.ArrowForward else null,
                        enabled = !isLoading,
                    )
                    Spacer(Modifier.height(6.dp))
                    Row(
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Default.Lock, null, tint = TextMuted, modifier = Modifier.size(12.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Secure Execution", color = TextMuted, fontSize = 11.sp)
                    }
                    Text(
                        text = "Your trade will be executed securely via Binance",
                        color = TextMuted,
                        fontSize = 10.sp,
                        textAlign = TextAlign.Center,
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
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {

                Spacer(Modifier.height(12.dp))

                Text(
                    text = "CONFIRM TRADE",
                    color = CyanPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 22.sp,
                    letterSpacing = 2.sp,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Review your trade details and calculations before confirming.",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                )

                Spacer(Modifier.height(14.dp))

                CoinInfoCard(candidate = candidate)

                Spacer(Modifier.height(14.dp))

                GlowCard {
                    Column(modifier = Modifier.fillMaxWidth()) {

                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Calculate, null, tint = Color(0xFFBB86FC), modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "CALCULATION SUMMARY",
                                color = Color(0xFFBB86FC),
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                letterSpacing = 1.2.sp,
                            )
                        }

                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Here's how your trade setup looks based on the details you entered:",
                            color = TextSecondary,
                            fontSize = 11.sp,
                            lineHeight = 17.sp,
                        )

                        Spacer(Modifier.height(14.dp))
                        Divider(color = NavyBorder, thickness = 0.5.dp)
                        Spacer(Modifier.height(10.dp))

                        SummaryRow("Entry Price",        "${"%.2f".format(entryPrice)} USDT",       TextPrimary)
                        SummaryRow("Stop Loss Price",    "${"%.2f".format(stopLossPrice)} USDT",    LossRed)
                        SummaryRow("Take Profit Price",  "${"%.2f".format(takeProfitPrice)} USDT",  ProfitGreen)
                        SummaryRow("Position Size",      "${"%.2f".format(positionSize)} USDT",     TextPrimary)
                        SummaryRow("Stop Loss %",        "${"%.2f".format(stopLossPct)}%",          LossRed)
                        SummaryRow("Take Profit %",      "${"%.2f".format(takeProfitPct)}%",        ProfitGreen)
                        SummaryRow("Risk / Reward Ratio", rrRatio,                                 TextPrimary)
                        SummaryRow("Potential Profit",   "+${"%.2f".format(potentialProfit)} USDT", ProfitGreen)
                        SummaryRow("Potential Loss",     "-${"%.2f".format(potentialLoss)} USDT",   LossRed)

                        Spacer(Modifier.height(10.dp))
                        Divider(color = NavyBorder, thickness = 0.5.dp)
                        Spacer(Modifier.height(10.dp))

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                "Estimated P&L",
                                color = ProfitGreen,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp,
                            )
                            Text(
                                "+${"%.2f".format(estimatedPnl)} USDT (+${"%.2f".format(takeProfitPct)}%)",
                                color = ProfitGreen,
                                fontWeight = FontWeight.ExtraBold,
                                fontSize = 14.sp,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0x1400B4FF), RoundedCornerShape(10.dp))
                        .border(1.dp, CyanPrimary.copy(alpha = 0.2f), RoundedCornerShape(10.dp))
                        .padding(12.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(Icons.Default.Info, null, tint = CyanPrimary, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "These calculations are based on the current market price and may vary as market conditions change.",
                        color = TextSecondary,
                        fontSize = 11.sp,
                        lineHeight = 17.sp,
                    )
                }

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
            .padding(vertical = 5.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = TextSecondary, fontSize = 13.sp)
        Text(value, color = valueColor, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}
