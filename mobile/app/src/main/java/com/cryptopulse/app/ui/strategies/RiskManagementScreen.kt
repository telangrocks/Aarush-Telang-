package com.cryptopulse.app.ui.strategies

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
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
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.SpaceBetween
            ) {
                // Screen Title
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp, bottom = 8.dp)
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
                            .padding(horizontal = 6.dp, vertical = 6.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .background(ProfitGreen, CircleShape)
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = "TAKE PROFIT DISTANCE (ATR)",
                                    color = Color(0xFFE2EDF9),
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.5.sp,
                                    letterSpacing = 0.8.sp
                                )
                            }
                            Box(
                                modifier = Modifier
                                    .background(
                                        color = ProfitGreen.copy(alpha = 0.12f),
                                        shape = RoundedCornerShape(8.dp)
                                    )
                                    .border(
                                        width = 1.dp,
                                        color = ProfitGreen.copy(alpha = 0.45f),
                                        shape = RoundedCornerShape(8.dp)
                                    )
                                    .padding(horizontal = 10.dp, vertical = 4.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = String.format(java.util.Locale.US, "%.1fx", state.atrTakeProfitMultiplier),
                                    color = ProfitGreen,
                                    fontWeight = FontWeight.ExtraBold,
                                    fontSize = 16.sp,
                                    style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                                )
                            }
                        }

                        Spacer(Modifier.height(10.dp))

                        RiskDistanceSlider(
                            value = state.atrTakeProfitMultiplier.toFloat(),
                            onValueChange = { viewModel.updateAtrTakeProfit(it.toDouble()) },
                            valueRange = 1.0f..5.0f,
                            steps = 40,
                            accentColor = ProfitGreen
                        )

                        Spacer(Modifier.height(4.dp))

                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                text = "1.0x (Min)",
                                color = Color(0xFF6888A8),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Medium
                            )
                            Text(
                                text = "5.0x (Max)",
                                color = Color(0xFF6888A8),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Medium
                            )
                        }
                    }
                }

                Spacer(Modifier.height(10.dp))

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

                Spacer(Modifier.height(10.dp))

                // 3. Stop Loss Distance (ATR) Card
                GlowCard(
                    modifier = Modifier.fillMaxWidth(),
                    borderColor = WarningOrange
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 6.dp, vertical = 6.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .background(WarningOrange, CircleShape)
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = "STOP LOSS DISTANCE (ATR)",
                                    color = Color(0xFFE2EDF9),
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.5.sp,
                                    letterSpacing = 0.8.sp
                                )
                            }
                            Box(
                                modifier = Modifier
                                    .background(
                                        color = WarningOrange.copy(alpha = 0.12f),
                                        shape = RoundedCornerShape(8.dp)
                                    )
                                    .border(
                                        width = 1.dp,
                                        color = WarningOrange.copy(alpha = 0.45f),
                                        shape = RoundedCornerShape(8.dp)
                                    )
                                    .padding(horizontal = 10.dp, vertical = 4.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = String.format(java.util.Locale.US, "%.1fx", state.atrStopLossMultiplier),
                                    color = WarningOrange,
                                    fontWeight = FontWeight.ExtraBold,
                                    fontSize = 16.sp,
                                    style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                                )
                            }
                        }

                        Spacer(Modifier.height(10.dp))

                        RiskDistanceSlider(
                            value = state.atrStopLossMultiplier.toFloat(),
                            onValueChange = { viewModel.updateAtrStopLoss(it.toDouble()) },
                            valueRange = 0.5f..5.0f,
                            steps = 45,
                            accentColor = WarningOrange
                        )

                        Spacer(Modifier.height(4.dp))

                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                text = "0.5x (Min)",
                                color = Color(0xFF6888A8),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Medium
                            )
                            Text(
                                text = "5.0x (Max)",
                                color = Color(0xFF6888A8),
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Medium
                            )
                        }
                    }
                }

                Spacer(Modifier.height(8.dp))
            }
        }
    }
}

/**
 * Custom cyber-styled Slider featuring a 24dp glowing radial thumb,
 * gradient active track bar, and clean guide track.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RiskDistanceSlider(
    value: Float,
    onValueChange: (Float) -> Unit,
    valueRange: ClosedFloatingPointRange<Float>,
    steps: Int = 0,
    accentColor: Color,
    modifier: Modifier = Modifier
) {
    val fraction = ((value - valueRange.start) / (valueRange.endInclusive - valueRange.start)).coerceIn(0f, 1f)

    Slider(
        value = value,
        onValueChange = onValueChange,
        valueRange = valueRange,
        steps = steps,
        modifier = modifier
            .fillMaxWidth()
            .height(38.dp),
        thumb = {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .drawBehind {
                        drawCircle(
                            brush = Brush.radialGradient(
                                colors = listOf(
                                    accentColor.copy(alpha = 0.65f),
                                    accentColor.copy(alpha = 0.2f),
                                    Color.Transparent
                                ),
                                radius = 18.dp.toPx()
                            )
                        )
                    }
                    .background(Color(0xFF061122), CircleShape)
                    .border(2.5.dp, accentColor, CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .background(Color.White, CircleShape)
                )
            }
        },
        track = {
            Canvas(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(20.dp)
            ) {
                val trackHeight = 5.dp.toPx()
                val yCenter = size.height / 2f
                val activeWidth = size.width * fraction

                // Active track (glowing gradient bar)
                if (activeWidth > 0f) {
                    drawRoundRect(
                        brush = Brush.horizontalGradient(
                            listOf(
                                accentColor.copy(alpha = 0.5f),
                                accentColor
                            ),
                            startX = 0f,
                            endX = activeWidth
                        ),
                        topLeft = Offset(0f, yCenter - trackHeight / 2f),
                        size = Size(activeWidth, trackHeight),
                        cornerRadius = CornerRadius(trackHeight / 2f, trackHeight / 2f)
                    )
                }

                // Inactive track (evenly spaced guide dots)
                val dotSpacing = 8.dp.toPx()
                val dotRadius = 1.3.dp.toPx()
                var currentX = activeWidth + 12.dp.toPx()
                val endX = size.width - 4.dp.toPx()
                while (currentX <= endX) {
                    drawCircle(
                        color = Color(0xFF264A78),
                        radius = dotRadius,
                        center = Offset(currentX, yCenter)
                    )
                    currentX += dotSpacing
                }
            }
        }
    )
}
