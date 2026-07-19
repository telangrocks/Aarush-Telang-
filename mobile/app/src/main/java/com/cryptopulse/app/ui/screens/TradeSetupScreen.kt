package com.cryptopulse.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.cryptopulse.app.data.api.KlineDto
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.ColoredGlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.theme.*
import kotlin.math.abs
import kotlin.math.max

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TradeSetupScreen(
    candidate: MarketCandidate,
    onBack: () -> Unit,
    onProceedToConfirm: (entryPrice: Double, stopLoss: Double, takeProfit: Double) -> Unit,
    viewModel: ExchangeViewModel = hiltViewModel(),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    var isLoading by remember { mutableStateOf(true) }

    val ticker by viewModel.ticker.collectAsState(initial = null)
    val klines by viewModel.klines.collectAsState(initial = emptyList())

    val marketPrice = ticker?.price ?: candidate.currentMarketPrice
    val minNotional = ticker?.minNotional ?: candidate.minNotional
    val minOrderQty = ticker?.minOrderQty ?: 0.001
    val maxOrderQty = ticker?.maxOrderQty ?: 999999999.0
    val lotSize = ticker?.lotSize ?: 1.0

    var entryPriceText by remember(marketPrice) { mutableStateOf(if (marketPrice > 0) "%.2f".format(marketPrice) else "") }
    val entryPrice = entryPriceText.toDoubleOrNull() ?: 0.0

    LaunchedEffect(Unit) {
        viewModel.fetchTicker()
        viewModel.fetchKlines("1h", 100)
    }

    LaunchedEffect(ticker, klines) {
        if (ticker != null && klines.isNotEmpty()) {
            isLoading = false
        }
    }

    val atr = remember(klines) {
        calculateAtr(klines, 14)
    }
    val stopLoss = if (atr > 0) entryPrice - (atr * 1.0) else entryPrice * 0.99
    val takeProfit = if (atr > 0) entryPrice + (atr * 2.0) else entryPrice * 1.02

    val riskPct = if (entryPrice > 0) abs((stopLoss - entryPrice) / entryPrice * 100) else 0.0
    val rewardPct = if (entryPrice > 0) abs((takeProfit - entryPrice) / entryPrice * 100) else 0.0
    val rrRatio = if (riskPct > 0) "%.2f : 1".format(rewardPct / riskPct) else "–"

    val canProceed = entryPrice > 0 && !isLoading

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
                        .padding(horizontal = 20.dp, vertical = 12.dp)
                ) {
                    GradientButton(
                        text = if (isLoading) "Loading..." else "Confirm & Choose Strategy",
                        onClick = {
                            if (canProceed && stopLoss != null && takeProfit != null) {
                                onProceedToConfirm(entryPrice, stopLoss, takeProfit)
                            }
                        },
                        enabled = canProceed && !isLoading,
                        leadingIcon = if (isLoading) Icons.Default.HourglassEmpty else Icons.Default.Check,
                        testTag = "trade_setup_proceed_button",
                    )
                }
            }
        ) { padding ->

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp)
                    .testTag("trade_setup_root"),
            ) {

                Spacer(Modifier.height(12.dp))

                Text(
                    text = "TRADE SETUP",
                    color = CyanPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 22.sp,
                    letterSpacing = 2.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Review auto-calculated SL/TP based on ATR, then confirm.",
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
                            .height(120.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator(color = CyanPrimary)
                            Spacer(Modifier.height(12.dp))
                            Text("Fetching latest market data...", color = TextSecondary, fontSize = 13.sp)
                        }
                    }
                } else {
                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                SectionHeader(icon = Icons.Default.AttachMoney, title = "ENTRY PRICE")
                                Text(
                                    text = "LIVE",
                                    color = ProfitGreen,
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier
                                        .background(ProfitGreen.copy(alpha = 0.15f), RoundedCornerShape(4.dp))
                                        .padding(horizontal = 6.dp, vertical = 2.dp),
                                )
                            }
                            Spacer(Modifier.height(10.dp))
                            TradeTextField(
                                value = entryPriceText,
                                onValueChange = { entryPriceText = it },
                                placeholder = "Enter entry price",
                                testTag = "trade_setup_entry_price",
                            )
                            Spacer(Modifier.height(8.dp))
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(Color(0xFF251A00), RoundedCornerShape(8.dp))
                                    .border(1.dp, Color(0xFFFFB300).copy(alpha = 0.3f), RoundedCornerShape(8.dp))
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(Icons.Default.Warning, null, tint = Color(0xFFFFB300), modifier = Modifier.size(14.dp))
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    text = "Minimum trade value: $${String.format("%.2f", minNotional)} USDT",
                                    color = Color(0xFFFFB300),
                                    fontSize = 11.sp,
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    ColoredGlowCard(
                        modifier = Modifier.weight(1f),
                        borderColor = LossRed,
                    ) {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            SectionHeader(
                                icon = Icons.Default.Shield,
                                title = "STOP LOSS (ATR)",
                                iconTint = LossRed,
                                textColor = LossRed,
                            )
                            Spacer(Modifier.height(8.dp))
                            TradeFieldLabel("STOP LOSS PRICE (USDT)")
                            Spacer(Modifier.height(4.dp))
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(NavyCard, RoundedCornerShape(10.dp))
                                    .border(1.dp, NavyBorder, RoundedCornerShape(10.dp))
                                    .testTag("trade_setup_stop_loss")
                                    .padding(horizontal = 12.dp, vertical = 14.dp),
                            ) {
                                Text(
                                    text = stopLoss?.let { String.format("%.2f", it) + " USDT" } ?: "–",
                                    color = TextPrimary,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Medium,
                                )
                            }
                            Spacer(Modifier.height(6.dp))
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text("Risk %", color = TextMuted, fontSize = 10.sp)
                                Text(
                                    text = riskPct?.let { "${"%.2f".format(it)}%" } ?: "–",
                                    color = LossRed,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                            if (atr > 0) {
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    text = "ATR (14): ${"%.2f".format(atr)}",
                                    color = TextMuted,
                                    fontSize = 10.sp,
                                )
                            }
                        }
                    }

                    ColoredGlowCard(
                        modifier = Modifier.weight(1f),
                        borderColor = ProfitGreen,
                    ) {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            SectionHeader(
                                icon = Icons.Default.TrendingUp,
                                title = "TAKE PROFIT (ATR)",
                                iconTint = ProfitGreen,
                                textColor = ProfitGreen,
                            )
                            Spacer(Modifier.height(8.dp))
                            TradeFieldLabel("TAKE PROFIT PRICE (USDT)")
                            Spacer(Modifier.height(4.dp))
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(NavyCard, RoundedCornerShape(10.dp))
                                    .border(1.dp, NavyBorder, RoundedCornerShape(10.dp))
                                    .testTag("trade_setup_take_profit")
                                    .padding(horizontal = 12.dp, vertical = 14.dp),
                            ) {
                                Text(
                                    text = takeProfit?.let { String.format("%.2f", it) + " USDT" } ?: "–",
                                    color = TextPrimary,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Medium,
                                )
                            }
                            Spacer(Modifier.height(6.dp))
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text("Reward %", color = TextMuted, fontSize = 10.sp)
                                Text(
                                    text = rewardPct?.let { "${"%.2f".format(it)}%" } ?: "–",
                                    color = ProfitGreen,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                 GlowCard {
                     Column(modifier = Modifier.fillMaxWidth()) {
                         SectionHeader(icon = Icons.Default.TrendingUp, title = "ESTIMATED P&L")
                         Spacer(Modifier.height(12.dp))

                         Row(
                             modifier = Modifier.fillMaxWidth(),
                             horizontalArrangement = Arrangement.SpaceBetween,
                         ) {
                             PnlMetric(
                                 label = "ESTIMATED PROFIT",
                                 value = "+${"%.2f".format(rewardPct)}%",
                                 color = ProfitGreen,
                             )
                             PnlMetric(
                                 label = "RISK / REWARD",
                                 value = rrRatio,
                                 color = TextPrimary,
                             )
                             PnlMetric(
                                 label = "ESTIMATED LOSS",
                                 value = "-${"%.2f".format(riskPct)}%",
                                 color = LossRed,
                             )
                         }

                         Spacer(Modifier.height(14.dp))

                         TradeFieldLabel("POSITION SIZE")
                         Spacer(Modifier.height(6.dp))
                         Row(
                             modifier = Modifier.fillMaxWidth(),
                             verticalAlignment = Alignment.CenterVertically,
                         ) {
                             Box(
                                 modifier = Modifier
                                     .background(CyanPrimary.copy(alpha = 0.15f), RoundedCornerShape(6.dp))
                                     .border(1.dp, CyanPrimary.copy(alpha = 0.4f), RoundedCornerShape(6.dp))
                                     .padding(horizontal = 10.dp, vertical = 6.dp),
                             ) {
                                 Text(
                                     text = "AUTO",
                                     color = CyanPrimary,
                                     fontSize = 12.sp,
                                     fontWeight = FontWeight.Bold,
                                     letterSpacing = 1.sp,
                                 )
                             }
                             Spacer(Modifier.width(10.dp))
                             Text(
                                 text = "Calculated automatically",
                                 color = TextMuted,
                                 fontSize = 11.sp,
                             )
                         }
                     }
                 }

                Spacer(Modifier.height(12.dp))

                Text(
                    text = "ⓘ  SL and TP are auto-calculated using 14-period ATR. Default Risk/Reward = 1:2.",
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

private fun calculateAtr(klines: List<KlineDto>, period: Int): Double {
    if (klines.size < period + 1) return 0.0
    val trueRanges = klines.zipWithNext { prev, curr ->
        val tr1 = curr.high - curr.low
        val tr2 = abs(curr.high - prev.close)
        val tr3 = abs(curr.low - prev.close)
        maxOf(tr1, tr2, tr3)
    }
    val recentTrs = trueRanges.takeLast(period)
    return recentTrs.average()
}

// ─── Shared sub-composables ───────────────────────────────────────────────────

@Composable
internal fun CoinInfoCard(candidate: MarketCandidate) {
    androidx.compose.foundation.layout.Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(NavyCard, RoundedCornerShape(12.dp))
            .border(1.dp, NavyBorder, RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .background(candidate.coinColor.copy(alpha = 0.18f), androidx.compose.foundation.shape.CircleShape)
                .border(1.5.dp, candidate.coinColor.copy(alpha = 0.6f), androidx.compose.foundation.shape.CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(candidate.symbol.take(2), color = candidate.coinColor, fontWeight = FontWeight.ExtraBold, fontSize = 14.sp)
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(candidate.pairName, color = TextPrimary, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp)
            Text(candidate.coinName, color = TextSecondary, fontSize = 12.sp)
        }
        Column(horizontalAlignment = Alignment.End) {
            Box(
                modifier = Modifier
                    .border(1.dp, ProfitGreen, RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Star, null, tint = ProfitGreen, modifier = Modifier.size(11.dp))
                    Spacer(Modifier.width(3.dp))
                    Text("Rank #${candidate.rank}", color = ProfitGreen, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
            }
            Spacer(Modifier.height(4.dp))
            Text("${candidate.notations}+ NOTATIONS", color = ProfitGreen, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun SectionHeader(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    iconTint: Color = CyanPrimary,
    textColor: Color = CyanPrimary,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = iconTint, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(title, color = textColor, fontWeight = FontWeight.Bold, fontSize = 13.sp, letterSpacing = 1.2.sp)
    }
}

@Composable
private fun TradeFieldLabel(text: String) {
    Text(text, color = TextSecondary, fontSize = 10.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.8.sp)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TradeTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    isError: Boolean = false,
    testTag: String? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder, color = TextMuted, fontSize = 13.sp) },
        trailingIcon = {
            Text("USDT", color = CyanPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(end = 8.dp))
        },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        singleLine = true,
        isError = isError,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = if (isError) LossRed else CyanPrimary,
            unfocusedBorderColor = if (isError) LossRed else NavyBorder,
            cursorColor = if (isError) LossRed else CyanPrimary,
            errorBorderColor = LossRed,
            focusedTextColor = TextPrimary,
            unfocusedTextColor = TextPrimary,
            focusedContainerColor = NavyCard,
            unfocusedContainerColor = NavyCard,
        ),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth().then(
            if (testTag != null) Modifier.testTag(testTag) else Modifier
        ),
    )
}

@Composable
private fun PnlMetric(
    label: String,
    value: String,
    color: Color,
    subValue: String? = null,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, color = TextMuted, fontSize = 9.sp, letterSpacing = 0.4.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(4.dp))
        Text(value, color = color, fontSize = 13.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center)
        if (subValue != null) {
            Text(subValue, color = color.copy(alpha = 0.7f), fontSize = 10.sp, textAlign = TextAlign.Center)
        }
    }
}


