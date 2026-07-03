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
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.ColoredGlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.theme.*
import kotlin.math.abs

/**
 * Trade Setup Screen — entirely new screen matching the reference design.
 *
 * Allows the user to enter:
 *   • Entry price
 *   • Stop Loss price (auto-calculates risk %)
 *   • Take Profit price (auto-calculates reward %)
 *   • Position size
 *
 * Shows a real-time Estimated P&L panel. On "Calculate P&L" / "Proceed",
 * navigates to the Trade Confirmation screen with all values passed forward.
 *
 * No existing functionality is removed — this is an additive new screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TradeSetupScreen(
    candidate: MarketCandidate,
    onBack: () -> Unit,
    onProceedToConfirm: (entryPrice: Double, stopLoss: Double, takeProfit: Double, positionSize: Double) -> Unit,
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    // ── Form state ────────────────────────────────────────────────────────────
    var entryPriceText   by remember { mutableStateOf("") }
    var stopLossText     by remember { mutableStateOf("") }
    var takeProfitText   by remember { mutableStateOf("") }
    var positionSizeText by remember { mutableStateOf("") }

    // Parsed doubles (null = invalid / empty)
    val entryPrice   = entryPriceText.toDoubleOrNull()
    val stopLoss     = stopLossText.toDoubleOrNull()
    val takeProfit   = takeProfitText.toDoubleOrNull()
    val positionSize = positionSizeText.toDoubleOrNull()

    // ── Derived P&L values ────────────────────────────────────────────────────
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

    val canProceed = entryPrice != null && stopLoss != null && takeProfit != null && positionSize != null && entryPrice > 0

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
                        text = "Calculate P&L",
                        onClick = {
                            if (canProceed) {
                                onProceedToConfirm(entryPrice!!, stopLoss!!, takeProfit!!, positionSize!!)
                            }
                        },
                        enabled = canProceed,
                        leadingIcon = Icons.Default.Calculate,
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

                // ── Page title ────────────────────────────────────────────
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
                    text = "Enter your trade details to calculate potential profit.",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(14.dp))

                // ── Coin info card ────────────────────────────────────────
                CoinInfoCard(candidate = candidate)

                Spacer(Modifier.height(14.dp))

                // ── Entry price card ──────────────────────────────────────
                GlowCard {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        SectionHeader(icon = Icons.Default.AttachMoney, title = "ENTER ENTRY PRICE")
                        Spacer(Modifier.height(10.dp))
                        TradeFieldLabel("ENTRY PRICE (USDT)")
                        Spacer(Modifier.height(4.dp))
                        TradeTextField(
                            value = entryPriceText,
                            onValueChange = { entryPriceText = it },
                            placeholder = "Enter entry price",
                        )
                        Spacer(Modifier.height(6.dp))
                        Text(
                            text = "Current Market Price: ${candidate.currentMarketPrice} USDT",
                            color = CyanPrimary,
                            fontSize = 11.sp,
                        )
                    }
                }

                Spacer(Modifier.height(12.dp))

                // ── Stop Loss + Take Profit side by side ──────────────────
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    // Stop Loss
                    ColoredGlowCard(
                        modifier = Modifier.weight(1f),
                        borderColor = LossRed,
                    ) {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            SectionHeader(
                                icon = Icons.Default.Shield,
                                title = "STOP LOSS",
                                iconTint = LossRed,
                                textColor = LossRed,
                            )
                            Spacer(Modifier.height(8.dp))
                            TradeFieldLabel("STOP LOSS PRICE (USDT)")
                            Spacer(Modifier.height(4.dp))
                            TradeTextField(
                                value = stopLossText,
                                onValueChange = { stopLossText = it },
                                placeholder = "Enter stop loss",
                            )
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
                        }
                    }

                    // Take Profit
                    ColoredGlowCard(
                        modifier = Modifier.weight(1f),
                        borderColor = ProfitGreen,
                    ) {
                        Column(modifier = Modifier.fillMaxWidth()) {
                            SectionHeader(
                                icon = Icons.Default.TrendingUp,
                                title = "TAKE PROFIT",
                                iconTint = ProfitGreen,
                                textColor = ProfitGreen,
                            )
                            Spacer(Modifier.height(8.dp))
                            TradeFieldLabel("TAKE PROFIT PRICE (USDT)")
                            Spacer(Modifier.height(4.dp))
                            TradeTextField(
                                value = takeProfitText,
                                onValueChange = { takeProfitText = it },
                                placeholder = "Enter take profit",
                            )
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

                // ── Estimated P&L card ────────────────────────────────────
                GlowCard {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        SectionHeader(icon = Icons.Default.TrendingUp, title = "ESTIMATED P&L")
                        Spacer(Modifier.height(12.dp))

                        // Three-column summary
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

                        // Position size field
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

                // Footer disclaimer
                Text(
                    text = "ⓘ  This is an estimate. Actual results may vary based on market conditions.",
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
        // Avatar
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
            // Rank badge
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
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor      = CyanPrimary,
            unfocusedBorderColor    = NavyBorder,
            cursorColor             = CyanPrimary,
            focusedTextColor        = TextPrimary,
            unfocusedTextColor      = TextPrimary,
            focusedContainerColor   = NavyCard,
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
