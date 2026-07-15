package com.cryptopulse.app.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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
import com.cryptopulse.app.ui.theme.*
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PositionsScreen(
    onBack: () -> Unit,
    viewModel: ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    val scope = rememberCoroutineScope()
    var isRefreshing by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        viewModel.fetchPositions()
    }

    val positions by viewModel.positions.collectAsState(initial = emptyList())

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgGradient)
    ) {
        Scaffold(
            topBar = { CryptoPulseTopBar(onBack = onBack) },
            containerColor = Color.Transparent,
        ) { padding ->

            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                item {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        text = "TRADE POSITIONS",
                        color = CyanPrimary,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 22.sp,
                        letterSpacing = 2.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "Monitor your open and closed trades",
                        color = TextSecondary,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(14.dp))
                }

                if (positions.isEmpty()) {
                    item {
                        Spacer(Modifier.height(40.dp))
                        Text(
                            text = "No positions yet",
                            color = TextSecondary,
                            fontSize = 14.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = "Activate the bot and execute trades to see them here.",
                            color = TextMuted,
                            fontSize = 12.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                } else {
                    items(positions) { position ->
                        val positionId = position["id"] as? String ?: return@items
                        PositionCard(
                            position = position,
                            onClose = {
                                scope.launch {
                                    viewModel.closePosition(positionId)
                                    viewModel.fetchPositions()
                                }
                            },
                        )
                        Spacer(Modifier.height(10.dp))
                    }
                }

                item {
                    Spacer(Modifier.height(20.dp))
                }
            }
        }
    }
}

@Composable
private fun PositionCard(position: Map<String, Any>, onClose: () -> Unit) {
    val symbol = (position["symbol"] as? String) ?: "UNKNOWN"
    val side = (position["side"] as? String) ?: "BUY"
    val entryPrice = (position["entry_price"] as? Double) ?: 0.0
    val currentPrice = (position["current_price"] as? Double?)
    val livePnl = (position["live_pnl"] as? Double?)
    val status = (position["status"] as? String) ?: "OPEN"
    val stopLoss = (position["stop_loss"] as? Double) ?: 0.0
    val takeProfit = (position["take_profit"] as? Double) ?: 0.0
    val quantity = (position["quantity"] as? Double) ?: 0.0
    val strategy = (position["strategy"] as? String) ?: ""
    val exchange = (position["exchange"] as? String) ?: ""
    val realizedPnl = (position["realized_pnl"] as? Double?)
    val closeReason = (position["close_reason"] as? String?)

    val isOpen = status == "OPEN"
    val pnlDisplay = if (isOpen && livePnl != null) livePnl else realizedPnl ?: 0.0
    val pnlColor = if (pnlDisplay >= 0) ProfitGreen else LossRed

    GlowCard {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = symbol,
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp,
                    )
                    Spacer(Modifier.width(8.dp))
                    Box(
                        modifier = Modifier
                            .background(
                                if (side == "BUY") Color(0xFF00BFA5).copy(alpha = 0.15f) else Color(0xFFFF5252).copy(alpha = 0.15f),
                                RoundedCornerShape(4.dp)
                            )
                            .padding(horizontal = 8.dp, vertical = 4.dp)
                    ) {
                        Text(
                            text = side,
                            color = if (side == "BUY") Color(0xFF00BFA5) else Color(0xFFFF5252),
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
                Box(
                    modifier = Modifier
                        .background(
                            if (isOpen) Color(0xFF00BFA5).copy(alpha = 0.15f) else Color(0xFF9E9E9E).copy(alpha = 0.15f),
                            RoundedCornerShape(4.dp)
                    )
                    .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Text(
                        text = status,
                        color = if (isOpen) Color(0xFF00BFA5) else Color(0xFF9E9E9E),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }

            Spacer(Modifier.height(10.dp))
            Divider(color = NavyBorder, thickness = 0.5.dp)
            Spacer(Modifier.height(10.dp))

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column {
                    Text("Entry", color = TextMuted, fontSize = 10.sp)
                    Text("$${"%.2f".format(entryPrice)}", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("Qty", color = TextMuted, fontSize = 10.sp)
                    Text("${"%.4f".format(quantity)}", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }

            Spacer(Modifier.height(8.dp))

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column {
                    Text("Stop Loss", color = TextMuted, fontSize = 10.sp)
                    Text("$${"%.2f".format(stopLoss)}", color = LossRed, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("Take Profit", color = TextMuted, fontSize = 10.sp)
                    Text("$${"%.2f".format(takeProfit)}", color = ProfitGreen, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }

            if (currentPrice != null) {
                Spacer(Modifier.height(8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column {
                        Text("Current", color = TextMuted, fontSize = 10.sp)
                        Text("$${"%.2f".format(currentPrice)}", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(if (isOpen) "Live P&L" else "Realized P&L", color = TextMuted, fontSize = 10.sp)
                        Text(
                            text = "${if (pnlDisplay >= 0) "+" else ""}${"%.4f".format(pnlDisplay)} USDT",
                            color = pnlColor,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }

            if (!isOpen && closeReason != null) {
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "Closed: $closeReason",
                    color = TextMuted,
                    fontSize = 10.sp,
                )
            }

            if (strategy.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Strategy: $strategy • $exchange",
                    color = TextMuted,
                    fontSize = 10.sp,
                )
            }

            if (isOpen) {
                Spacer(Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    OutlinedButton(
                        onClick = onClose,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = LossRed),
                        border = ButtonDefaults.outlinedButtonBorder.copy(brush = Brush.horizontalGradient(listOf(LossRed, LossRed))),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    ) {
                        Icon(Icons.Default.Close, null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Close Position", fontSize = 12.sp)
                    }
                }
            }
        }
    }
}
