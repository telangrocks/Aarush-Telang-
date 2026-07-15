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
    onProceedToConfirm: (entryPrice: Double, stopLoss: Double, takeProfit: Double, positionSize: Double) -> Unit,
    viewModel: ExchangeViewModel = hiltViewModel(),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    var entryPriceText by remember { mutableStateOf("") }
    var positionSizeText by remember { mutableStateOf("") }
    var entryPriceError by remember { mutableStateOf<String?>(null) }
    var isLoading by remember { mutableStateOf(true) }

    val ticker by viewModel.ticker.collectAsState(initial = null)
    val klines by viewModel.klines.collectAsState(initial = emptyList())

    val entryPrice = entryPriceText.toDoubleOrNull()
    val positionSize = positionSizeText.toDoubleOrNull()

    val defaultPositionSize = max(candidate.minNotional * 10.0, 100.0)

    LaunchedEffect(Unit) {
        viewModel.fetchTicker()
        viewModel.fetchKlines("1h", 100)
    }

    LaunchedEffect(ticker, klines) {
        if (ticker != null && klines.isNotEmpty()) {
            isLoading = false
            if (entryPriceText.isEmpty()) {
                entryPriceText = String.format("%.2f", ticker!!.price)
            }
            if (positionSizeText.isEmpty()) {
                positionSizeText = String.format("%.2f", defaultPositionSize)
            }
        }
    }

    val atr = remember(klines) {
        calculateAtr(klines, 14)
    }

    val stopLoss = entryPrice?.let { price ->
        if (atr > 0) price - (atr * 1.0) else price * 0.99
    }

    val takeProfit = entryPrice?.let { price ->
        if (atr > 0) price + (atr * 2.0) else price * 1.02
    }

    val riskPct = if (entryPrice != null && entryPrice > 0 && stopLoss != null)
        abs((stopLoss - entryPrice) / entryPrice * 100) else null

    val rewardPct = if (entryPrice != null && entryPrice > 0 && takeProfit != null)
        abs((takeProfit - entryPrice) / entryPrice * 100) else null

    val rrRatio = if (riskPct != null && riskPct > 0 && rewardPct != null)
        "%.2f : 1".format(rewardPct / riskPct) else "0.00 : 1"

    val estimatedProfit = if (entryPrice != null && takeProfit != null && positionSize != null && entryPrice > 0)
        (takeProfit - entryPrice) / entryPrice * positionSize else null

    val estimatedLoss = if (entryPrice != null && stopLoss != null && positionSize != null && entryPrice > 0)
        (entryPrice - stopLoss) / entryPrice * positionSize else null

    val canProceed = entryPrice != null && entryPrice > 0 &&
                     positionSize != null && positionSize > 0 &&
                     entryPrice >= candidate.minNotional

    LaunchedEffect(entryPriceText) {
        if (entryPriceText.isNotEmpty() && entryPrice == null) {
            entryPriceError = "Invalid price format"
        } else if (entryPrice != null && entryPrice < candidate.minNotional) {
            entryPriceError = "Entry price must be at least $${String.format("%.2f", candidate.minNotional)}"
        } else {
            entryPriceError = null
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
                        .padding(horizontal = 20.dp, vertical = 12.dp)
                ) {
                    GradientButton(
                        text = if (isLoading) "Loading..." else "Proceed to Confirmation",
                        onClick = {
                            if (canProceed) {
                                onProceedToConfirm(entryPrice!!, stopLoss!!, takeProfit!!, positionSize!!)
                            }
                        },
                        enabled = canProceed && !isLoading,
                        leadingIcon = if (isLoading) Icons.Default.HourglassEmpty else Icons.Default.Check,
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
                            SectionHeader(icon = Icons.Default.AttachMoney, title = "ENTRY PRICE")
                            Spacer(Modifier.height(10.dp))
                            TradeFieldLabel("ENTRY PRICE (USDT)")
                            Spacer(Modifier.height(4.dp))
                            TradeTextField(
                                value = entryPriceText,
                                onValueChange = { entryPriceText = it },
                                placeholder = "Enter entry price",
                                isError = entryPriceError != null,
                            )
                            Spacer(Modifier.height(4.dp))
                            if (entryPriceError != null) {
                                Text(
                                    text = entryPriceError!!,
                                    color = LossRed,
                                    fontSize = 11.sp,
                                )
                            } else if (ticker != null) {
                                Text(
                                    text = "Live Price: ${String.format("%.2f", ticker!!.price)} USDT | Min Notional: $${String.format("%.2f", candidate.minNotional)}",
                                    color = CyanPrimary,
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
                                value = estimatedProfit?.let { "+${"%.2f".format(it)} USDT" } ?: "0.00 USDT",
                                subValue = estimatedProfit?.let { rewardPct?.let { r -> "(+${"%.2f".format(r)}%)" } } ?: "(0.00%)",
                                color = ProfitGreen,
                            )
                            PnlMetric(
                                label = "RISK / REWARD",
                                value = rrRatio,
                                color = TextPrimary,
                            )
                            PnlMetric(
                                label = "ESTIMATED LOSS",
                                value = estimatedLoss?.let { "-${"%.2f".format(it)} USDT" } ?: "0.00 USDT",
                                subValue = estimatedLoss?.let { riskPct?.let { r -> "(-${"%.2f".format(r)}%)" } } ?: "(0.00%)",
                                color = LossRed,
                            )
                        }

                        Spacer(Modifier.height(14.dp))

                        TradeFieldLabel("POSITION SIZE (USDT)")
                        Spacer(Modifier.height(4.dp))
                        TradeTextField(
                            value = positionSizeText,
                            onValueChange = { positionSizeText = it },
                            placeholder = "Enter position size",
                        )
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
        modifier = Modifier.fillMaxWidth(),
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
