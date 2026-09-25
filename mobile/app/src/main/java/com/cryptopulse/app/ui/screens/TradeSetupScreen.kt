package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.text.TextStyle
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
import kotlinx.coroutines.launch
import java.util.Locale
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.R
import com.cryptopulse.app.ui.components.CoinInfoCard
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.components.LocalOnLogout
import com.cryptopulse.app.ui.strategies.TradeSetupConfigResult
import com.cryptopulse.app.ui.strategies.TradeSetupViewModel
import com.cryptopulse.app.ui.strategies.components.DynamicFieldRenderer
import com.cryptopulse.app.ui.theme.*
import com.cryptopulse.app.ui.utils.Formatters

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TradeSetupScreen(
    candidate: MarketCandidate? = null,
    balance: Double?,
    balancesError: String?,
    asset: String,
    exchangeName: String,
    environmentName: String,
    onBack: () -> Unit,
    onProceedToAnalysis: () -> Unit,
    viewModel: TradeSetupViewModel,
    onRefresh: (() -> Unit)? = null,
    isRefreshing: Boolean = false,
) {
    val bgGradient = Brush.verticalGradient(
        listOf(
            Color(0xFF000916),
            Color(0xFF000B1B),
            Color(0xFF000D1E),
            Color(0xFF000814)
        )
    )
    val uiState by viewModel.uiState.collectAsState()
    val scope = rememberCoroutineScope()
    val onLogout = LocalOnLogout.current

    // Pulse glow animation for ambient constellation breathing
    val glowAnim = rememberInfiniteTransition(label = "trade_setup_glow")
    val pulseGlow by glowAnim.animateFloat(
        initialValue = 0.96f,
        targetValue = 1.02f,
        animationSpec = infiniteRepeatable(
            animation = tween(2400, easing = EaseInOut),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulse_glow"
    )

    LaunchedEffect(candidate) {
        if (candidate != null) {
            viewModel.setConstraints(candidate, exchangeName)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgGradient)
            .testTag("trade_setup_root")
    ) {
        // Ambient Bottom Horizon Flare
        TradeSetupBottomHorizonGlow(
            modifier = Modifier
                .fillMaxWidth()
                .height(180.dp)
                .align(Alignment.BottomCenter)
                .padding(bottom = 85.dp)
        )

        Scaffold(
            topBar = {
                TradeSetupTopBar(
                    onBack = onBack,
                    onRefresh = onRefresh,
                    isRefreshing = isRefreshing,
                    onLogout = { onLogout?.invoke() }
                )
            },
            containerColor = Color.Transparent,
            bottomBar = {
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
                            .padding(horizontal = 16.dp, vertical = 14.dp)
                    ) {
                        val isButtonEnabled = !uiState.isLoading && uiState.error == null
                        TradeSetupConfirmButton(
                            text = if (uiState.isLoading) "Loading..." else "CONFIRM",
                            enabled = isButtonEnabled,
                            onClick = {
                                scope.launch {
                                    val result = viewModel.validateAndConfirmTrade(
                                        candidate = candidate,
                                        exchangeName = exchangeName,
                                        availableBalance = balance
                                    )
                                    if (result is TradeSetupConfigResult.Success) {
                                        onProceedToAnalysis()
                                    }
                                }
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("trade_setup_proceed_button")
                        )
                    }
                }
            }
        ) { padding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.TopCenter
            ) {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .widthIn(max = 680.dp)
                        .padding(horizontal = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    item {
                        Spacer(Modifier.height(14.dp))

                        // Title: TRADE SETUP
                        Text(
                            text = "TRADE SETUP",
                            color = Color(0xFF00E5FF),
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 24.sp,
                            letterSpacing = 2.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = "Configure global execution rules for autonomous trading.",
                            color = Color(0xFFFF3355),
                            fontSize = 14.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = 0.3.sp,
                            textAlign = TextAlign.Center,
                            style = TextStyle(
                                shadow = Shadow(
                                    color = Color(0x99FF3355),
                                    offset = Offset(0f, 0f),
                                    blurRadius = 10f
                                )
                            ),
                            modifier = Modifier.fillMaxWidth(),
                        )

                        Spacer(Modifier.height(18.dp))

                        // Card 1: Autonomous Engine Universe Card
                        AutonomousUniverseCard()

                        Spacer(Modifier.height(12.dp))

                        // Card 2: Available Balance Card
                        AvailableBalanceCard(
                            balance = balance,
                            balancesError = balancesError,
                            asset = asset,
                            exchangeName = exchangeName,
                            environmentName = environmentName
                        )

                        Spacer(Modifier.height(16.dp))
                    }

                    if (uiState.isLoading) {
                        item {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(32.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                CircularProgressIndicator(color = Color(0xFF00B4FF))
                            }
                        }
                    } else {
                        if (uiState.error != null) {
                            item {
                                Text(
                                    text = "Error: ${uiState.error}",
                                    color = LossRed,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(16.dp),
                                    textAlign = TextAlign.Center
                                )
                            }
                        }

                        item {
                            // Card: Professional TRADE SETUP Box containing Trade Amount (USDT)
                            TradeSetupTargetEntryPriceCard(
                                asset = asset,
                                tradeAmount = uiState.tradeAmountUsdt,
                                tradeAmountError = uiState.tradeAmountError,
                                onTradeAmountChange = { viewModel.updateTradeAmount(it, balance) }
                            )
                        }
                    }

                    // Golden Crypto Planetary Constellation Graphic below Trade Amount
                    item {
                        Spacer(Modifier.height(18.dp))

                        Image(
                            painter = painterResource(id = R.drawable.img_crypto_constellation),
                            contentDescription = "Crypto Planetary Constellation",
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 6.dp)
                                .graphicsLayer {
                                    scaleX = pulseGlow
                                    scaleY = pulseGlow
                                },
                            contentScale = ContentScale.FillWidth
                        )

                        Spacer(Modifier.height(24.dp))
                    }
                }
            }
        }
    }
}

/**
 * Reusable cyber-styled card container with glowing cyan halo and gradient border.
 */
@Composable
private fun TradeSetupCardContainer(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) {
    val cardRadius = 16.dp
    val borderBrush = Brush.verticalGradient(
        listOf(
            Color(0xFF00B4FF),
            Color(0xFF0077E6),
            Color(0xFF0044AA),
        )
    )

    Box(
        modifier = modifier
            .fillMaxWidth()
            .drawBehind {
                drawRoundRect(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color(0x3500B4FF),
                            Color(0x120066FF),
                            Color.Transparent
                        ),
                        center = Offset(size.width / 2f, size.height / 2f),
                        radius = size.width * 0.60f
                    ),
                    cornerRadius = CornerRadius(cardRadius.toPx() + 4.dp.toPx(), cardRadius.toPx() + 4.dp.toPx())
                )
            }
            .clip(RoundedCornerShape(cardRadius))
            .background(
                Brush.verticalGradient(
                    listOf(
                        Color(0xE6081426),
                        Color(0xF2050D1A)
                    )
                )
            )
            .border(
                width = 1.4.dp,
                brush = borderBrush,
                shape = RoundedCornerShape(cardRadius)
            )
            .padding(horizontal = 16.dp, vertical = 14.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            content = content
        )
    }
}

/**
 * Polished cryptocurrency coin cluster emblem (BTC, ETH, SOL) combined into one unified cyber graphic.
 */
@Composable
private fun CryptoCoinClusterGraphic(
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .size(48.dp)
            .clip(CircleShape)
            .background(
                Brush.radialGradient(
                    listOf(Color(0xFF0F2038), Color(0xFF060E1A))
                )
            )
            .border(
                1.5.dp,
                Brush.linearGradient(
                    listOf(Color(0xFF00E5FF), Color(0xFF7048E8), Color(0xFF00B4FF))
                ),
                CircleShape
            ),
        contentAlignment = Alignment.Center
    ) {
        // 1. Top-Left: Ethereum (ETH) Coin
        Box(
            modifier = Modifier
                .size(22.dp)
                .offset(x = (-8).dp, y = (-7).dp)
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        listOf(Color(0xFF4A68FF), Color(0xFF162354))
                    )
                )
                .border(0.8.dp, Color(0xFF88A0F8), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Canvas(modifier = Modifier.size(13.dp)) {
                val w = size.width
                val h = size.height
                val cx = w / 2f
                val cy = h / 2f

                // Upper diamond
                val topPath = Path().apply {
                    moveTo(cx, 0f)
                    lineTo(w, cy * 0.85f)
                    lineTo(cx, cy * 1.15f)
                    lineTo(0f, cy * 0.85f)
                    close()
                }
                drawPath(topPath, Color.White.copy(alpha = 0.95f))

                // Left facet shading
                val leftShade = Path().apply {
                    moveTo(cx, 0f)
                    lineTo(0f, cy * 0.85f)
                    lineTo(cx, cy * 1.15f)
                    close()
                }
                drawPath(leftShade, Color(0xFF00E5FF).copy(alpha = 0.5f))

                // Lower diamond
                val botPath = Path().apply {
                    moveTo(cx, cy * 1.35f)
                    lineTo(w, cy * 1.05f)
                    lineTo(cx, h)
                    lineTo(0f, cy * 1.05f)
                    close()
                }
                drawPath(botPath, Color.White.copy(alpha = 0.90f))
            }
        }

        // 2. Top-Right: Solana (SOL) Coin
        Box(
            modifier = Modifier
                .size(20.dp)
                .offset(x = 9.dp, y = (-7).dp)
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        listOf(Color(0xFF261042), Color(0xFF100520))
                    )
                )
                .border(0.8.dp, Color(0xFFB526FF), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Column(
                verticalArrangement = Arrangement.spacedBy(1.5.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Box(
                    modifier = Modifier
                        .width(11.dp)
                        .height(2.2.dp)
                        .clip(RoundedCornerShape(1.dp))
                        .background(Brush.horizontalGradient(listOf(Color(0xFF00FFA3), Color(0xFF00D4FF))))
                )
                Box(
                    modifier = Modifier
                        .width(11.dp)
                        .height(2.2.dp)
                        .clip(RoundedCornerShape(1.dp))
                        .background(Brush.horizontalGradient(listOf(Color(0xFF00D4FF), Color(0xFF9945FF))))
                )
                Box(
                    modifier = Modifier
                        .width(11.dp)
                        .height(2.2.dp)
                        .clip(RoundedCornerShape(1.dp))
                        .background(Brush.horizontalGradient(listOf(Color(0xFF9945FF), Color(0xFFDC1FFF))))
                )
            }
        }

        // 3. Foreground Center-Bottom: Golden Bitcoin (BTC) Coin
        Box(
            modifier = Modifier
                .size(26.dp)
                .offset(x = 0.dp, y = 7.dp)
                .drawBehind {
                    drawCircle(
                        color = Color(0x77000000),
                        radius = size.width * 0.55f,
                        center = Offset(size.width / 2f, size.height / 2f + 1.5.dp.toPx())
                    )
                }
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        listOf(
                            Color(0xFFFFE082),
                            Color(0xFFFFB300),
                            Color(0xFFF57C00),
                            Color(0xFFB25000)
                        )
                    )
                )
                .border(1.2.dp, Color(0xFFFFF8E1), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "₿",
                color = Color.White,
                fontSize = 15.sp,
                fontWeight = FontWeight.ExtraBold,
                textAlign = TextAlign.Center,
                style = TextStyle(
                    shadow = Shadow(
                        color = Color(0x66000000),
                        offset = Offset(0.5f, 0.5f),
                        blurRadius = 2f
                    )
                )
            )
        }
    }
}

/**
 * First Card: Autonomous Engine Universe Card.
 * Represents the multi-pair trading universe with professional crypto coin bunch emblem.
 */
@Composable
private fun AutonomousUniverseCard() {
    TradeSetupCardContainer {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Polished Cryptocurrency Coin Bunch Emblem
            CryptoCoinClusterGraphic()

            Spacer(Modifier.width(14.dp))

            // Engine & Universe Title
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "AUTONOMOUS ENGINE",
                    color = Color(0xFF00E5FF),
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = "Top 25 Pairs",
                    color = Color.White,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 18.sp,
                    letterSpacing = 0.4.sp
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = "Continuous market scanning on Bybit",
                    color = Color(0xFF94B0D0),
                    fontSize = 11.5.sp,
                    fontWeight = FontWeight.Normal
                )
            }

            // Multi-Pair Engine Status Badge
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(Color(0x2000E676))
                    .border(1.dp, Color(0xFF00E676), RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 3.5.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(Color(0xFF00E676))
                    )
                    Spacer(Modifier.width(5.dp))
                    Text(
                        text = "MULTI-PAIR",
                        color = Color(0xFF00E676),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }
    }
}

/**
 * Second Card: Available Balance Card.
 */
@Composable
fun AvailableBalanceCard(
    balance: Double?,
    balancesError: String?,
    asset: String,
    exchangeName: String,
    environmentName: String
) {
    val accessibleBalanceText = if (balancesError != null) {
        "Error: $balancesError"
    } else if (balance != null) {
        "Available balance ${String.format(java.util.Locale.US, "%,.2f", balance)} $asset on $exchangeName $environmentName."
    } else {
        "Fetching wallet balance."
    }

    TradeSetupCardContainer(
        modifier = Modifier
            .testTag("available_balance_card")
            .semantics(mergeDescendants = true) {
                contentDescription = accessibleBalanceText
            }
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Available Balance",
                color = Color(0xFF94B0D0),
                fontSize = 13.5.sp,
                fontWeight = FontWeight.Medium,
                letterSpacing = 0.2.sp
            )

            // Bold, neat, professional Bybit DEMO / REAL cyber badge
            val isDemo = environmentName.contains("demo", ignoreCase = true)
            val badgeColor = if (isDemo) Color(0xFF00E5FF) else Color(0xFF00FFA3)
            val badgeBg = if (isDemo) Color(0x1800E5FF) else Color(0x1800FFA3)
            val badgeBorder = if (isDemo) Color(0xFF00E5FF).copy(alpha = 0.5f) else Color(0xFF00FFA3).copy(alpha = 0.5f)

            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(badgeBg)
                    .border(1.dp, badgeBorder, RoundedCornerShape(6.dp))
                    .padding(horizontal = 9.dp, vertical = 4.dp)
            ) {
                Text(
                    text = "${exchangeName.uppercase()} • ${environmentName.uppercase()}",
                    color = badgeColor,
                    fontSize = 11.5.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = 0.8.sp
                )
            }
        }

        Spacer(Modifier.height(8.dp))

        if (balancesError != null) {
            Text(
                text = "Error: $balancesError",
                color = LossRed,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.5.sp
            )
        } else if (balance != null) {
            val formatted = String.format(java.util.Locale.US, "%,.2f", balance)
            Text(
                text = "$formatted $asset",
                color = Color(0xFF00FFA3),
                fontSize = 25.sp,
                fontWeight = FontWeight.ExtraBold,
                letterSpacing = 0.5.sp
            )
        } else {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(vertical = 4.dp)
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    color = Color(0xFF00B4FF),
                    strokeWidth = 2.dp
                )
                Text(
                    text = "Fetching wallet balance...",
                    color = Color(0xFF94B0D0),
                    fontSize = 13.sp
                )
            }
        }
    }
}

/**
 * Third Card: Trade Amount (USDT) / Dynamic Market Entry Input Card.
 */
@Composable
fun TradeSetupTargetEntryPriceCard(
    asset: String,
    tradeAmount: String = "5.00",
    tradeAmountError: String? = null,
    onTradeAmountChange: (String) -> Unit = {},
    previewPrice: Double = 0.0,
    entryPrice: String = "",
    entryPriceError: String? = null,
) {
    val displayAsset = asset.ifBlank { "USDT" }.uppercase()
    TradeSetupCardContainer {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Enter your trading capital",
                color = Color(0xFF94B0D0),
                fontSize = 13.5.sp,
                fontWeight = FontWeight.Medium,
                letterSpacing = 0.2.sp
            )
        }

        Spacer(Modifier.height(8.dp))

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF040B16))
                .border(
                    width = 1.2.dp,
                    color = if (tradeAmountError != null) LossRed else Color(0xFF0084FF).copy(alpha = 0.6f),
                    shape = RoundedCornerShape(12.dp)
                )
                .padding(horizontal = 16.dp)
                .testTag("trade_setup_entry_price"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            BasicTextField(
                value = tradeAmount,
                onValueChange = onTradeAmountChange,
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                textStyle = TextStyle(
                    color = Color(0xFF00FFA3),
                    fontSize = 25.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = 0.5.sp
                ),
                modifier = Modifier
                    .weight(1f)
                    .testTag("trade_setup_trade_amount_input")
            )
            Text(
                text = displayAsset,
                color = Color(0xFF00FFA3),
                fontSize = 25.sp,
                fontWeight = FontWeight.ExtraBold,
                letterSpacing = 0.5.sp
            )
        }

        if (tradeAmountError != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = tradeAmountError,
                color = LossRed,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium
            )
        }
    }
}

/**
 * Top App Bar with back navigation, centered master branding lockup, refresh and logout actions.
 */
@Composable
private fun TradeSetupTopBar(
    onBack: (() -> Unit)?,
    onRefresh: (() -> Unit)?,
    isRefreshing: Boolean,
    onLogout: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .height(52.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        if (onBack != null) {
            IconButton(
                onClick = onBack,
                modifier = Modifier.size(40.dp)
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back",
                    tint = Color.White,
                    modifier = Modifier.size(24.dp)
                )
            }
        } else {
            Spacer(Modifier.width(40.dp))
        }

        TradeSetupHeaderLockup()

        Row(
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (onRefresh != null) {
                IconButton(
                    onClick = onRefresh,
                    enabled = !isRefreshing,
                    modifier = Modifier.size(40.dp)
                ) {
                    if (isRefreshing) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                            color = Color(0xFF00B4FF)
                        )
                    } else {
                        Icon(
                            imageVector = Icons.Default.Refresh,
                            contentDescription = "Refresh",
                            tint = Color(0xFF00B4FF),
                            modifier = Modifier.size(22.dp)
                        )
                    }
                }
            } else {
                Spacer(Modifier.width(40.dp))
            }

            IconButton(
                onClick = onLogout,
                modifier = Modifier.size(40.dp)
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ExitToApp,
                    contentDescription = "Logout",
                    tint = Color.White,
                    modifier = Modifier.size(24.dp)
                )
            }
        }
    }
}

/**
 * Centered Master CryptoPulse Branding Lockup.
 */
@Composable
private fun TradeSetupHeaderLockup() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Image(
            painter = painterResource(id = R.drawable.ic_cryptopulse_splash_logo),
            contentDescription = "CryptoPulse Logo",
            modifier = Modifier.size(34.dp),
            contentScale = ContentScale.Fit
        )

        Spacer(Modifier.width(8.dp))

        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "CRYPTO",
                    color = Color.White,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 18.sp,
                    letterSpacing = 1.1.sp,
                )
                Text(
                    text = "PULSE",
                    color = Color(0xFF00B4FF),
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 18.sp,
                    letterSpacing = 1.1.sp,
                )
            }
            Text(
                text = "TRADE SMART. STAY AHEAD.",
                color = Color(0xFF00B4FF).copy(alpha = 0.85f),
                fontSize = 7.5.sp,
                letterSpacing = 1.6.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/**
 * Ambient bottom horizon reflection flare on the floor of the screen.
 */
@Composable
private fun TradeSetupBottomHorizonGlow(
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val center = Offset(w / 2f, h * 0.75f)

        // Diffuse ambient blue
        drawOval(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color(0x450084FF),
                    Color(0x180055CC),
                    Color.Transparent
                ),
                center = center,
                radius = w * 0.45f
            ),
            topLeft = Offset(center.x - w * 0.45f, center.y - 35.dp.toPx()),
            size = Size(w * 0.90f, 70.dp.toPx())
        )

        // Bright cyan horizon core
        drawOval(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color(0xFFB5EFFF),
                    Color(0xDD00B4FF),
                    Color(0x440066FF),
                    Color.Transparent
                ),
                center = center,
                radius = w * 0.20f
            ),
            topLeft = Offset(center.x - w * 0.20f, center.y - 7.dp.toPx()),
            size = Size(w * 0.40f, 14.dp.toPx())
        )
    }
}

/**
 * Bottom Confirm CTA Button with cyan-to-purple gradient, glow, and checkmark icon.
 */
@Composable
private fun TradeSetupConfirmButton(
    text: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val buttonRadius = 24.dp
    val buttonGradient = if (enabled) {
        Brush.horizontalGradient(
            listOf(
                Color(0xFF0099FF),
                Color(0xFF6B42FF),
                Color(0xFFB526FF),
            )
        )
    } else {
        Brush.horizontalGradient(
            listOf(
                Color(0xFF1E3A5F),
                Color(0xFF2A2E4E),
            )
        )
    }

    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(buttonRadius),
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.Transparent,
            disabledContainerColor = Color.Transparent,
        ),
        contentPadding = PaddingValues(0.dp),
        modifier = modifier
            .fillMaxWidth()
            .height(54.dp)
            .drawBehind {
                if (enabled) {
                    drawRoundRect(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                Color(0x5500B4FF),
                                Color(0x358B5CF6),
                                Color.Transparent
                            ),
                            center = Offset(size.width / 2f, size.height / 2f),
                            radius = size.width * 0.55f
                        ),
                        cornerRadius = CornerRadius(buttonRadius.toPx() + 6.dp.toPx(), buttonRadius.toPx() + 6.dp.toPx())
                    )
                }
            }
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(buttonGradient, RoundedCornerShape(buttonRadius)),
            contentAlignment = Alignment.Center,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
                modifier = Modifier.padding(horizontal = 24.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.Check,
                    contentDescription = null,
                    tint = if (enabled) Color.White else Color.White.copy(alpha = 0.5f),
                    modifier = Modifier.size(22.dp)
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = text,
                    color = if (enabled) Color.White else Color.White.copy(alpha = 0.5f),
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 16.sp,
                    letterSpacing = 1.2.sp,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/**
 * Fourth Card: Expandable Risk Controls Card.
 * Allows users to optionally customize Take Profit and Stop Loss distances (ATR),
 * while defaulting to native strategy presets when untouched.
 */
@Composable
fun TradeSetupRiskSettingsCard(
    atrTakeProfitMultiplier: Double? = null,
    atrStopLossMultiplier: Double? = null,
    onAtrTakeProfitChange: (Double) -> Unit = {},
    onAtrStopLossChange: (Double) -> Unit = {},
    onResetRisk: () -> Unit = {},
    modifier: Modifier = Modifier,
    riskRewardRatio: Double? = atrTakeProfitMultiplier,
    onRiskRewardChange: (Double) -> Unit = onAtrTakeProfitChange
) {
    val effectiveTp = atrTakeProfitMultiplier ?: riskRewardRatio
    val effectiveOnChange = if (atrTakeProfitMultiplier != null) onAtrTakeProfitChange else onRiskRewardChange
    var isExpanded by remember { mutableStateOf(false) }
    val isCustomized = effectiveTp != null || atrStopLossMultiplier != null

    TradeSetupCardContainer(
        modifier = modifier.testTag("trade_setup_risk_settings_card")
    ) {
        // Clickable header to toggle expansion
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable { isExpanded = !isExpanded }
                .padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Default.Shield,
                    contentDescription = null,
                    tint = Color(0xFF00E5FF),
                    modifier = Modifier.size(20.dp)
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "RISK CONTROLS (OPTIONAL)",
                    color = Color(0xFF94B0D0),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.8.sp
                )
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (isCustomized) Color(0x2500E676) else Color(0x2000B4FF))
                        .border(
                            1.dp,
                            if (isCustomized) Color(0xFF00E676) else Color(0xFF00B4FF).copy(alpha = 0.5f),
                            RoundedCornerShape(6.dp)
                        )
                        .padding(horizontal = 6.dp, vertical = 2.5.dp)
                ) {
                    Text(
                        text = if (isCustomized) "CUSTOMIZED" else "STRATEGY PRESETS",
                        color = if (isCustomized) Color(0xFF00E676) else Color(0xFF00E5FF),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
                Spacer(Modifier.width(6.dp))
                Icon(
                    imageVector = if (isExpanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                    contentDescription = if (isExpanded) "Collapse" else "Expand",
                    tint = Color(0xFF94B0D0),
                    modifier = Modifier.size(20.dp)
                )
            }
        }

        if (isExpanded) {
            Spacer(Modifier.height(10.dp))
            Text(
                text = "Leave as Strategy Presets to allow each strategy to apply its mathematically verified parameters, or adjust sliders below to customize.",
                color = Color(0xFF7E97B4),
                fontSize = 11.sp,
                lineHeight = 15.sp
            )

            Spacer(Modifier.height(14.dp))

            // Slider 1: Take Profit Distance (ATR)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "TAKE PROFIT DISTANCE (ATR)",
                    color = Color(0xFF94B0D0),
                    fontWeight = FontWeight.Bold,
                    fontSize = 11.5.sp,
                    letterSpacing = 0.6.sp
                )
                val tpText = if (effectiveTp != null) {
                    String.format(Locale.US, "%.1fx", effectiveTp)
                } else {
                    "Preset (2.0x)"
                }
                Text(
                    text = tpText,
                    color = Color(0xFF00FFA3),
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 14.sp
                )
            }
            Spacer(Modifier.height(6.dp))
            CyberRiskSlider(
                value = (effectiveTp ?: 2.0).toFloat(),
                onValueChange = { effectiveOnChange(it.toDouble()) },
                valueRange = 1.0f..5.0f,
                steps = 40,
                accentColor = Color(0xFF00FFA3),
                modifier = Modifier.testTag("trade_setup_rr_slider")
            )

            Spacer(Modifier.height(12.dp))

            // Slider 2: Stop Loss Distance (ATR)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "STOP LOSS DISTANCE (ATR)",
                    color = Color(0xFF94B0D0),
                    fontWeight = FontWeight.Bold,
                    fontSize = 11.5.sp,
                    letterSpacing = 0.6.sp
                )
                val atrText = if (atrStopLossMultiplier != null) {
                    String.format(Locale.US, "%.1fx", atrStopLossMultiplier)
                } else {
                    "Preset (1.5x)"
                }
                Text(
                    text = atrText,
                    color = Color(0xFFFFB300),
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 14.sp
                )
            }
            Spacer(Modifier.height(6.dp))
            CyberRiskSlider(
                value = (atrStopLossMultiplier ?: 1.5).toFloat(),
                onValueChange = { onAtrStopLossChange(it.toDouble()) },
                valueRange = 0.5f..5.0f,
                steps = 45,
                accentColor = Color(0xFFFFB300),
                modifier = Modifier.testTag("trade_setup_sl_slider")
            )

            if (isCustomized) {
                Spacer(Modifier.height(10.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End
                ) {
                    TextButton(
                        onClick = onResetRisk,
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)
                    ) {
                        Text(
                            text = "RESET TO STRATEGY PRESETS",
                            color = Color(0xFF00E5FF),
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        }
    }
}

/**
 * Custom cyber-styled Slider featuring glowing bar, cyber thumb, and dotted guide track.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CyberRiskSlider(
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
            .height(36.dp),
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
                    .height(18.dp)
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

                // Inactive track (evenly spaced dots)
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
