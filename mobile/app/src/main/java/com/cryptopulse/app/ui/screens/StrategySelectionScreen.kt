package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import com.cryptopulse.app.ui.components.CoinInfoCard

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.border
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.cryptopulse.app.ui.screens.MarketCandidate
import com.cryptopulse.app.domain.models.RiskLevel
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.StrategyCategory
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.strategies.StrategySelectionState
import com.cryptopulse.app.ui.strategies.StrategySelectionViewModel
import com.cryptopulse.app.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StrategySelectionScreen(
    candidate: MarketCandidate,
    onBack: () -> Unit,
    onProceedToTradeSetup: () -> Unit,
    viewModel: StrategySelectionViewModel
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    
    val uiState by viewModel.uiState.collectAsState()
    val selectedId by viewModel.selectedStrategyId.collectAsState()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgGradient)
            .testTag("strategy_selection_root")
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
                        text = "PROCEED TO TRADE SETUP",
                        onClick = onProceedToTradeSetup,
                        enabled = selectedId != null,
                        leadingIcon = Icons.Default.ArrowForward,
                        modifier = Modifier.testTag("proceed_to_trade_setup_button")
                    )
                }
            }
        ) { padding ->

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 16.dp),
            ) {
                Spacer(Modifier.height(14.dp))
                CoinInfoCard(candidate = candidate)
                Spacer(Modifier.height(16.dp))
                
                Text(
                    text = "SELECT STRATEGY",
                    color = CyanPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 18.sp,
                    letterSpacing = 1.5.sp,
                    modifier = Modifier.padding(bottom = 8.dp)
                )

                when (val state = uiState) {
                    is StrategySelectionState.Loading -> {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = CyanPrimary)
                        }
                    }
                    is StrategySelectionState.Error -> {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text(
                                text = "Error: ${state.message}",
                                color = LossRed,
                                textAlign = TextAlign.Center
                            )
                        }
                    }
                    is StrategySelectionState.Empty -> {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text(
                                text = "No strategies available for this asset.",
                                color = TextSecondary,
                                textAlign = TextAlign.Center
                            )
                        }
                    }
                    is StrategySelectionState.Success -> {
                        LazyColumn(
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                            contentPadding = PaddingValues(bottom = 80.dp)
                        ) {
                            items(state.strategies) { strategy ->
                                StrategyCard(
                                    strategy = strategy,
                                    isSelected = selectedId == strategy.id,
                                    onClick = { viewModel.selectStrategy(strategy.id) }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

fun Strategy.toAccessibilityDescription(): String {
    val riskText = "Risk level ${riskLevel.name.lowercase()}."
    val dirText = if (supportsLong && supportsShort) "Supports long and short." else if (supportsLong) "Supports long." else "Supports short."
    val tfText = if (supportedTimeframes.isNotEmpty()) "Timeframes ${supportedTimeframes.joinToString(", ")}." else ""
    return "$name. $description. $riskText $dirText $tfText"
}

@Composable
fun StrategyCard(strategy: Strategy, isSelected: Boolean, onClick: () -> Unit) {
    val borderColor = if (isSelected) CyanPrimary else Color.Transparent
    val bgColor = if (isSelected) Color(0xFF0D1E3A) else Color(0xFF131B2A)
    val icon = when (strategy.category) {
        StrategyCategory.SCALPING -> Icons.Default.Speed
        StrategyCategory.SWING -> Icons.Default.TrendingUp
        StrategyCategory.INTRADAY -> Icons.Default.SwapHoriz
        StrategyCategory.TREND_FOLLOWING -> Icons.Default.TrendingUp
        StrategyCategory.BREAKOUT -> Icons.Default.AutoGraph
        StrategyCategory.MEAN_REVERSION -> Icons.Default.SwapHoriz
        StrategyCategory.VWAP -> Icons.Default.AutoGraph
        else -> Icons.Default.AutoGraph
    }

    val riskColor = when (strategy.riskLevel) {
        RiskLevel.LOW -> ProfitGreen
        RiskLevel.MEDIUM -> Color(0xFFFFB300)
        RiskLevel.HIGH -> LossRed
    }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() }
            .testTag("strategy_option_${strategy.id.lowercase()}")
            .semantics(mergeDescendants = true) {
                contentDescription = strategy.toAccessibilityDescription()
            },
        color = bgColor,
        shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(if (isSelected) 2.dp else 1.dp, if (isSelected) borderColor else Color(0xFF2A3650))
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (isSelected) CyanPrimary else TextSecondary,
                modifier = Modifier.size(32.dp)
            )
            Spacer(modifier = Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = strategy.name,
                        color = if (isSelected) Color.White else TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp
                    )

                    // Risk Badge
                    Box(
                        modifier = Modifier
                            .background(riskColor.copy(alpha = 0.15f), RoundedCornerShape(4.dp))
                            .border(0.5.dp, riskColor.copy(alpha = 0.5f), RoundedCornerShape(4.dp))
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    ) {
                        Text(
                            text = "${strategy.riskLevel.name} RISK",
                            color = riskColor,
                            fontSize = 9.sp,
                            fontWeight = FontWeight.ExtraBold
                        )
                    }
                }

                Spacer(modifier = Modifier.height(4.dp))

                Text(
                    text = strategy.description,
                    color = TextSecondary,
                    fontSize = 12.sp,
                    lineHeight = 16.sp
                )

                Spacer(modifier = Modifier.height(8.dp))

                // Metadata tags row: Supported Timeframes & Direction support
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    if (strategy.supportsLong) {
                        Box(
                            modifier = Modifier
                                .background(ProfitGreen.copy(alpha = 0.12f), RoundedCornerShape(3.dp))
                                .padding(horizontal = 5.dp, vertical = 1.dp)
                        ) {
                            Text("LONG", color = ProfitGreen, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    if (strategy.supportsShort) {
                        Box(
                            modifier = Modifier
                                .background(LossRed.copy(alpha = 0.12f), RoundedCornerShape(3.dp))
                                .padding(horizontal = 5.dp, vertical = 1.dp)
                        ) {
                            Text("SHORT", color = LossRed, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                        }
                    }

                    if (strategy.supportedTimeframes.isNotEmpty()) {
                        Text(
                            text = "TF: ${strategy.supportedTimeframes.take(3).joinToString(", ")}",
                            color = TextMuted,
                            fontSize = 10.sp
                        )
                    }

                    Spacer(Modifier.weight(1f))

                    Text(
                        text = "v${strategy.version}",
                        color = TextMuted.copy(alpha = 0.7f),
                        fontSize = 10.sp
                    )
                }
            }

            if (isSelected) {
                Spacer(modifier = Modifier.width(12.dp))
                Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = "Selected",
                    tint = ProfitGreen,
                    modifier = Modifier.size(24.dp)
                )
            }
        }
    }
}


