package com.cryptopulse.app.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.platform.LocalContext
import androidx.hilt.navigation.compose.hiltViewModel
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StrategySelectionScreen(
    candidate: MarketCandidate,
    onBack: () -> Unit,
    onStrategySelected: (String) -> Unit,
    viewModel: com.cryptopulse.app.ui.auth.ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    val strategies = remember {
        listOf(
            StrategyItem("scalping", "Scalping", "Quick in-and-out trades capturing small price movements", Icons.Default.Speed),
            StrategyItem("momentum", "Momentum Trading", "Ride strong price trends with volume confirmation", Icons.Default.TrendingUp),
            StrategyItem("breakout", "Breakout Strategy", "Enter on price breaks above resistance or below support", Icons.Default.Bolt),
            StrategyItem("mean_reversion", "Mean Reversion", "Trade price extremes expecting return to average", Icons.Default.SwapHoriz),
            StrategyItem("vwap", "VWAP Strategy", "Trade around the Volume Weighted Average Price", Icons.Default.ShowChart),
        )
    }

    var selectedStrategy by remember { mutableStateOf<String?>(null) }
    val ticker by viewModel.ticker.collectAsState(initial = null)

    LaunchedEffect(Unit) {
        viewModel.fetchTicker()
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
                        .padding(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    GradientButton(
                        text = "Start Analysis",
                        onClick = {
                            selectedStrategy?.let { onStrategySelected(it) }
                        },
                        enabled = selectedStrategy != null,
                        leadingIcon = Icons.Default.PlayArrow,
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
                    text = "SELECT STRATEGY",
                    color = CyanPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 22.sp,
                    letterSpacing = 2.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Choose a world-class intraday trading strategy for ${candidate.pairName}",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(14.dp))

                CoinInfoCard(candidate = candidate)

                if (ticker != null) {
                    Spacer(Modifier.height(8.dp))
                    GlowCard {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column {
                                Text("LIVE PRICE", color = TextMuted, fontSize = 9.sp, letterSpacing = 0.5.sp)
                                Text(
                                    text = "$${String.format("%.2f", ticker!!.price)}",
                                    color = ProfitGreen,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 16.sp,
                                )
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text("24H CHANGE", color = TextMuted, fontSize = 9.sp, letterSpacing = 0.5.sp)
                                Text(
                                    text = "${if (ticker!!.priceChangePercent24h >= 0) "+" else ""}${String.format("%.2f", ticker!!.priceChangePercent24h)}%",
                                    color = if (ticker!!.priceChangePercent24h >= 0) ProfitGreen else LossRed,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 14.sp,
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(14.dp))

                GlowCard {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = "TOP 5 INTRADAY STRATEGIES",
                            color = CyanPrimary,
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp,
                            letterSpacing = 1.2.sp,
                        )
                        Spacer(Modifier.height(12.dp))

                        strategies.forEach { strategy ->
                            val isSelected = selectedStrategy == strategy.id
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { selectedStrategy = strategy.id }
                                    .background(
                                        if (isSelected) CyanPrimary.copy(alpha = 0.12f) else Color.Transparent,
                                        RoundedCornerShape(10.dp),
                                    )
                                    .border(
                                        width = if (isSelected) 1.5.dp else 0.5.dp,
                                        color = if (isSelected) CyanPrimary else NavyBorder,
                                        shape = RoundedCornerShape(10.dp),
                                    )
                                    .padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(40.dp)
                                        .background(
                                            if (isSelected) CyanPrimary.copy(alpha = 0.2f) else NavyCard,
                                            RoundedCornerShape(10.dp),
                                        ),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(
                                        strategy.icon,
                                        contentDescription = null,
                                        tint = if (isSelected) CyanPrimary else TextMuted,
                                        modifier = Modifier.size(22.dp),
                                    )
                                }
                                Spacer(Modifier.width(12.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = strategy.name,
                                        color = if (isSelected) CyanPrimary else TextPrimary,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 14.sp,
                                    )
                                    Spacer(Modifier.height(2.dp))
                                    Text(
                                        text = strategy.description,
                                        color = TextSecondary,
                                        fontSize = 11.sp,
                                        lineHeight = 16.sp,
                                    )
                                }
                                if (isSelected) {
                                    Icon(
                                        Icons.Default.CheckCircle,
                                        contentDescription = null,
                                        tint = CyanPrimary,
                                        modifier = Modifier.size(20.dp),
                                    )
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                Text(
                    text = "The bot will perform real-time technical analysis using the selected strategy.",
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

private data class StrategyItem(
    val id: String,
    val name: String,
    val description: String,
    val icon: androidx.compose.ui.graphics.vector.ImageVector,
)
