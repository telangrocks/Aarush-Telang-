package com.cryptopulse.app.ui.screens

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.ui.screens.MarketCandidate
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
    onProceed: () -> Unit,
    viewModel: StrategySelectionViewModel
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    
    val uiState by viewModel.uiState.collectAsState()
    val selectedId by viewModel.selectedStrategyId.collectAsState()

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
                        text = "Configure Setup",
                        onClick = onProceed,
                        enabled = selectedId != null,
                        leadingIcon = Icons.Default.PlayArrow
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
                    modifier = Modifier.padding(bottom = 12.dp)
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

@Composable
fun StrategyCard(strategy: Strategy, isSelected: Boolean, onClick: () -> Unit) {
    val borderColor = if (isSelected) CyanPrimary else Color.Transparent
    val bgColor = if (isSelected) Color(0xFF0D1E3A) else Color(0xFF131B2A)
    val icon = when (strategy.category) {
        StrategyCategory.SCALPING -> Icons.Default.Speed
        StrategyCategory.SWING -> Icons.Default.TrendingUp
        StrategyCategory.INTRADAY -> Icons.Default.SwapHoriz
        else -> Icons.Default.AutoGraph
    }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() },
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
            Spacer(modifier = Modifier.width(16.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = strategy.name,
                    color = if (isSelected) Color.White else TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = strategy.description,
                    color = TextSecondary,
                    fontSize = 12.sp,
                    lineHeight = 16.sp
                )
            }
            if (isSelected) {
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

