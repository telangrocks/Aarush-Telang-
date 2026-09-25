package com.cryptopulse.app.ui.strategies

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.R
import com.cryptopulse.app.domain.models.Strategy
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RiskManagementScreen(
    strategy: Strategy? = null,
    viewModel: RiskManagementViewModel,
    onProceedToAnalysis: (TradeSetupConfig) -> Unit,
    onBack: () -> Unit
) {
    LaunchedEffect(strategy) {
        viewModel.initialize(strategy)
    }

    val state by viewModel.state.collectAsState()
    val bgGradient = Brush.verticalGradient(
        listOf(
            Color(0xFF000916),
            Color(0xFF000B1B),
            Color(0xFF000D1E),
            Color(0xFF000814)
        )
    )

    Scaffold(
        topBar = { CryptoPulseTopBar(onBack = onBack) },
        containerColor = Color.Transparent,
        bottomBar = {
            Surface(
                color = NavyDeep,
                modifier = Modifier.fillMaxWidth()
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding(),
                    contentAlignment = Alignment.Center
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .widthIn(max = 680.dp)
                            .padding(horizontal = 16.dp, vertical = 12.dp)
                    ) {
                        GradientButton(
                            text = "PROCEED TO TECHNICAL ANALYSIS",
                            onClick = {
                                val updatedConfig = viewModel.getUpdatedConfig()
                                onProceedToAnalysis(updatedConfig)
                            },
                            enabled = true
                        )
                    }
                }
            }
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(bgGradient)
                .padding(padding),
            contentAlignment = Alignment.TopCenter
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .widthIn(max = 680.dp)
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.SpaceBetween
            ) {
                // Screen Title
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.Shield,
                        contentDescription = null,
                        tint = CyanPrimary,
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "RISK MANAGEMENT",
                        color = CyanPrimary,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 18.sp,
                        letterSpacing = 1.5.sp
                    )
                }

                // 1. Take Profit Distance (ATR) Card
                GlowCard(
                    modifier = Modifier.fillMaxWidth(),
                    borderColor = ProfitGreen
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 4.dp, vertical = 2.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "TAKE PROFIT DISTANCE (ATR)",
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 12.sp,
                                letterSpacing = 0.8.sp
                            )
                            Text(
                                text = String.format(java.util.Locale.US, "%.1fx", state.atrTakeProfitMultiplier),
                                color = ProfitGreen,
                                fontWeight = FontWeight.ExtraBold,
                                fontSize = 14.sp,
                                style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                            )
                        }
                        Spacer(Modifier.height(6.dp))
                        Slider(
                            value = state.atrTakeProfitMultiplier.toFloat(),
                            onValueChange = { viewModel.updateAtrTakeProfit(it.toDouble()) },
                            valueRange = 1.0f..5.0f,
                            steps = 40,
                            colors = SliderDefaults.colors(
                                thumbColor = ProfitGreen,
                                activeTrackColor = ProfitGreen,
                                inactiveTrackColor = NavyBorder
                            )
                        )
                    }
                }

                // 2. Static Coin-Bunch Constellation Branding
                Image(
                    painter = painterResource(id = R.drawable.img_crypto_constellation),
                    contentDescription = "Crypto Constellation Branding",
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 110.dp)
                        .padding(horizontal = 12.dp),
                    contentScale = ContentScale.Fit
                )

                // 3. Stop Loss Distance (ATR) Card
                GlowCard(
                    modifier = Modifier.fillMaxWidth(),
                    borderColor = WarningOrange
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 4.dp, vertical = 2.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "STOP LOSS DISTANCE (ATR)",
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 12.sp,
                                letterSpacing = 0.8.sp
                            )
                            Text(
                                text = String.format(java.util.Locale.US, "%.1fx", state.atrStopLossMultiplier),
                                color = WarningOrange,
                                fontWeight = FontWeight.ExtraBold,
                                fontSize = 14.sp,
                                style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                            )
                        }
                        Spacer(Modifier.height(6.dp))
                        Slider(
                            value = state.atrStopLossMultiplier.toFloat(),
                            onValueChange = { viewModel.updateAtrStopLoss(it.toDouble()) },
                            valueRange = 0.5f..5.0f,
                            steps = 45,
                            colors = SliderDefaults.colors(
                                thumbColor = WarningOrange,
                                activeTrackColor = WarningOrange,
                                inactiveTrackColor = NavyBorder
                            )
                        )
                    }
                }

                Spacer(Modifier.height(4.dp))
            }
        }
    }
}
