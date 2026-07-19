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
    onProceedToConfirm: (entryPrice: Double, stopLoss: Double, takeProfit: Double, positionSize: Double) -> Unit,
    viewModel: ExchangeViewModel = hiltViewModel(),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    // ── Entry Price state — tracks live price until user edits ─────────────
    var entryPriceText by remember { mutableStateOf("") }
    var userHasEditedEntry by remember { mutableStateOf(false) }
    var isLoading by remember { mutableStateOf(true) }

    val ticker by viewModel.ticker.collectAsState(initial = null)
    val klines by viewModel.klines.collectAsState(initial = emptyList())

    val marketPrice = ticker?.price ?: candidate.currentMarketPrice
    val minNotional  = ticker?.minNotional ?: candidate.minNotional
    val minOrderQty  = ticker?.minOrderQty ?: 0.001
    val maxOrderQty  = ticker?.maxOrderQty ?: 999999999.0
    val lotSize      = ticker?.lotSize ?: 1.0

    // Derive the quote currency from the symbol so the display is exchange-agnostic.
    // Binance/Bybit pairs end in USDT; Delta USD-settled perpetuals end in USD.
    val quoteCurrency = remember(candidate.symbol) {
        when {
            candidate.symbol.endsWith("USDT", ignoreCase = true) -> "USDT"
            candidate.symbol.endsWith("USD",  ignoreCase = true) -> "USD"
            candidate.symbol.endsWith("BTC",  ignoreCase = true) -> "BTC"
            candidate.symbol.endsWith("ETH",  ignoreCase = true) -> "ETH"
            candidate.symbol.length >= 3 -> candidate.symbol.takeLast(3).uppercase()
            else -> "USDT"
        }
    }

    LaunchedEffect(Unit) {
        viewModel.fetchTicker()
        viewModel.fetchKlines("1h", 100)
    }

    // ── Live-price tracking: only sync when the user has NOT edited the field ──
    LaunchedEffect(ticker) {
        if (ticker != null && ticker!!.price > 0) {
            isLoading = false
            if (!userHasEditedEntry) {
                entryPriceText = "%.2f".format(ticker!!.price)
            }
        }
    }

    LaunchedEffect(klines) {
        if (klines.isNotEmpty() && ticker != null) {
            isLoading = false
        }
    }

    // ── Derived trade values ───────────────────────────────────────────────
    val entryPrice = entryPriceText.toDoubleOrNull() ?: 0.0

    val atr = remember(klines) { calculateAtr(klines, 14) }

    val stopLoss   = if (atr > 0 && entryPrice > 0) entryPrice - (atr * 1.0) else if (entryPrice > 0) entryPrice * 0.99 else 0.0
    val takeProfit = if (atr > 0 && entryPrice > 0) entryPrice + (atr * 2.0) else if (entryPrice > 0) entryPrice * 1.02 else 0.0

    // Position size is managed entirely by the bot — computed here only for
    // the P&L preview. It must not be exposed to the user as an amount.
    val positionSizeInternal = remember(minNotional) { max(minNotional * 10.0, 100.0) }

    val estimatedQuantityRaw = if (positionSizeInternal > 0 && entryPrice > 0)
        positionSizeInternal / entryPrice else null

    val estimatedQuantity = estimatedQuantityRaw?.let { qty ->
        if (lotSize > 0) {
            val precision = if (lotSize < 1) Math.round(-Math.log10(lotSize)).toInt() else 0
            val rounded = Math.floor((qty / lotSize) + 1e-10) * lotSize
            val fixed = "%.${precision}f".format(rounded).toDoubleOrNull() ?: rounded
            fixed.coerceAtLeast(minOrderQty).coerceAtMost(maxOrderQty)
        } else qty
    }

    val riskPct    = if (entryPrice > 0) abs((stopLoss - entryPrice) / entryPrice * 100) else 0.0
    val rewardPct  = if (entryPrice > 0) abs((takeProfit - entryPrice) / entryPrice * 100) else 0.0
    val rrRatio    = if (riskPct > 0) "%.2f : 1".format(rewardPct / riskPct) else "–"

    val estimatedProfit = if (entryPrice > 0) (takeProfit - entryPrice) / entryPrice * positionSizeInternal else 0.0
    val estimatedLoss   = if (entryPrice > 0) (entryPrice - stopLoss) / entryPrice * positionSizeInternal else 0.0

    // Entry Price validation — the only required user input
    val entryPriceError: String? = when {
        entryPriceText.isNotEmpty() && entryPrice <= 0.0 -> "Please enter a valid price"
        else -> null
    }

    val canProceed = entryPrice > 0.0 && entryPriceError == null && !isLoading

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
                            if (canProceed) {
                                onProceedToConfirm(entryPrice, stopLoss, takeProfit, positionSizeInternal)
                            }
                        },
                        enabled = canProceed,
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
                    text = "Review auto-calculated SL/TP and confirm your entry price.",
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
                    // ── Entry Price Card ──────────────────────────────────────────
                    GlowCard {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            // Header row: label + live/custom badge
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                SectionHeader(icon = Icons.Default.AttachMoney, title = "ENTRY PRICE")
                                // Badge: LIVE when tracking, CUSTOM when user has edited
                                val badgeColor  = if (userHasEditedEntry) Color(0xFFFFB300) else ProfitGreen
                                val badgeLabel  = if (userHasEditedEntry) "CUSTOM" else "LIVE"
                                Text(
                                    text = badgeLabel,
                                    color = badgeColor,
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier
                                        .background(badgeColor.copy(alpha = 0.15f), RoundedCornerShape(4.dp))
                                        .padding(horizontal = 6.dp, vertical = 2.dp),
                                )
                            }

                            Spacer(Modifier.height(10.dp))

                            // Editable Entry Price field
                            TradeTextField(
                                value = entryPriceText,
                                onValueChange = { newValue ->
                                    entryPriceText = newValue
                                    // Lock to user's value; reset lock only when the field is cleared
                                    userHasEditedEntry = newValue.isNotEmpty()
                                },
                                placeholder = "Enter entry price",
                                trailingLabel = quoteCurrency,
                                isError = entryPriceError != null,
                                testTag = "trade_setup_entry_price",
                            )
                            if (entryPriceError != null) {
                                Spacer(Modifier.height(4.dp))
                                Text(entryPriceError, color = LossRed, fontSize = 11.sp)
                            }

                            Spacer(Modifier.height(10.dp))

                            // ── Minimum Notional Badge (prominent, amber) ─────────
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(Color(0xFFFFB300).copy(alpha = 0.10f), RoundedCornerShape(8.dp))
                                    .border(1.dp, Color(0xFFFFB300).copy(alpha = 0.35f), RoundedCornerShape(8.dp))
                                    .padding(horizontal = 10.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(
                                    Icons.Default.Warning,
                                    contentDescription = null,
                                    tint = Color(0xFFFFB300),
                                    modifier = Modifier.size(14.dp),
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    text = "Minimum trade value: ${String.format("%.2f", minNotional)} $quoteCurrency",
                                    color = Color(0xFFFFB300),
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                // ── Stop Loss & Take Profit Cards (read-only, auto ATR) ────────
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
                            TradeFieldLabel("STOP LOSS PRICE ($quoteCurrency)")
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
                                    text = if (stopLoss > 0) String.format("%.2f", stopLoss) + " $quoteCurrency" else "–",
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
                                    text = if (riskPct > 0) "${"%.2f".format(riskPct)}%" else "–",
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
                            TradeFieldLabel("TAKE PROFIT PRICE ($quoteCurrency)")
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
                                    text = if (takeProfit > 0) String.format("%.2f", takeProfit) + " $quoteCurrency" else "–",
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
                                    text = if (rewardPct > 0) "${"%.2f".format(rewardPct)}%" else "–",
                                    color = ProfitGreen,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                // ── Estimated P&L Card ────────────────────────────────────────
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
                                value = if (estimatedProfit > 0) "+${"%.2f".format(estimatedProfit)} $quoteCurrency" else "–",
                                subValue = if (rewardPct > 0) "(+${"%.2f".format(rewardPct)}%)" else null,
                                color = ProfitGreen,
                            )
                            PnlMetric(
                                label = "RISK / REWARD",
                                value = rrRatio,
                                color = TextPrimary,
                            )
                            PnlMetric(
                                label = "ESTIMATED LOSS",
                                value = if (estimatedLoss > 0) "-${"%.2f".format(estimatedLoss)} $quoteCurrency" else "–",
                                subValue = if (riskPct > 0) "(-${"%.2f".format(riskPct)}%)" else null,
                                color = LossRed,
                            )
                        }

                        Spacer(Modifier.height(14.dp))
                        Divider(color = NavyBorder, thickness = 0.5.dp)
                        Spacer(Modifier.height(10.dp))

                        // ── Position Size — read-only AUTO badge ──────────────
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column {
                                TradeFieldLabel("POSITION SIZE")
                                Spacer(Modifier.height(4.dp))
                                Box(
                                    modifier = Modifier
                                        .background(CyanPrimary.copy(alpha = 0.12f), RoundedCornerShape(8.dp))
                                        .border(1.dp, CyanPrimary.copy(alpha = 0.4f), RoundedCornerShape(8.dp))
                                        .padding(horizontal = 12.dp, vertical = 6.dp),
                                ) {
                                    Text(
                                        text = "AUTO",
                                        color = CyanPrimary,
                                        fontWeight = FontWeight.ExtraBold,
                                        fontSize = 13.sp,
                                        letterSpacing = 1.sp,
                                    )
                                }
                            }
                            // Estimated quantity (P&L preview — not a position size disclosure)
                            if (estimatedQuantity != null && estimatedQuantity > 0) {
                                Column(horizontalAlignment = Alignment.End) {
                                    TradeFieldLabel("EST. QUANTITY")
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        text = "~${"%.4f".format(estimatedQuantity)} ${candidate.symbol}",
                                        color = CyanPrimary,
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                }
                            }
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                Text(
                    text = "ⓘ  SL and TP are auto-calculated using 14-period ATR and update until you confirm.",
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
            // Only show notations when available (hidden for restored sessions)
            if (candidate.notations > 0) {
                Spacer(Modifier.height(4.dp))
                Text("${candidate.notations}+ NOTATIONS", color = ProfitGreen, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
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
    trailingLabel: String = "USDT",
    isError: Boolean = false,
    testTag: String? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder, color = TextMuted, fontSize = 13.sp) },
        trailingIcon = {
            Text(trailingLabel, color = CyanPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(end = 8.dp))
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
