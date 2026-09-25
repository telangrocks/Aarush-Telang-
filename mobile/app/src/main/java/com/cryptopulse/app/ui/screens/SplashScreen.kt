package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*


import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.cryptopulse.app.R
import com.cryptopulse.app.domain.repository.AuthRepository
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.repository.ExchangeRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.data.local.BiometricAuthManager
import com.cryptopulse.app.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.fragment.app.FragmentActivity

/**
 * Refurbished Flash/Splash Screen matching the reference design:
 *  – Deep midnight cosmic background with subtle gradient
 *  – Master Logo Mark with northeast arrow vector tip
 *  – "CRYPTOPULSE" wordmark + "TRADE SMART. STAY AHEAD." tagline
 *  – Glowing neon-cyan heartbeat pulse divider
 *  – "FOUNDED & BUILT BY / Shrikant Telang" creator branding
 *  – Glowing golden crypto constellation (BTC, ETH, BNB, SOL, DOGE, XRP, ADA, orbital rings, sparks, dual flares)
 *  – Radiant cyan-blue horizon reflection beam at the bottom floor
 *  – 100% preserved underlying authentication & navigation routing logic
 */
@Composable
fun SplashScreen(
    navController: NavController,
    tokenManager: TokenManager,
    exchangeConnectionManager: ExchangeConnectionManager,
    exchangeRepository: ExchangeRepository,
    botRepository: BotRepository,
    tradeSessionRepository: TradeSessionRepository,
    authRepository: AuthRepository? = null,
) {

    // ── Animation state ───────────────────────────────────────────────────
    var visible by remember { mutableStateOf(false) }

    val alpha by animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = tween(durationMillis = 1800, easing = EaseInOut),
        label = "splash_fade"
    )

    // Pulse glow animation for ambient horizon and constellation breathing
    val glowAnim = rememberInfiniteTransition(label = "glow")
    val pulseGlow by glowAnim.animateFloat(
        initialValue = 0.94f,
        targetValue  = 1.04f,
        animationSpec = infiniteRepeatable(
            animation  = tween(2200, easing = EaseInOut),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulse_glow"
    )

    // Read the Compose context OUTSIDE the coroutine — composition locals
    // (LocalContext) cannot be safely read from inside a LaunchedEffect block.
    val context = LocalContext.current

    LaunchedEffect(Unit) {
        visible = true
        var destination = "onboarding"
        var activeBotCoinId: String? = null
        var activeBotStrategy: String? = null
        try {
            withContext(Dispatchers.IO) {
                var token = tokenManager.getToken()
                if (tokenManager.isTokenExpired(token)) {
                    val refreshToken = tokenManager.getRefreshToken()
                    if (!refreshToken.isNullOrEmpty() && !tokenManager.isTokenExpired(refreshToken) && authRepository != null) {
                        val refreshResult = authRepository.refreshToken()
                        token = if (refreshResult is com.cryptopulse.app.core.network.NetworkResult.Success) {
                            tokenManager.getToken()
                        } else {
                            tokenManager.clearTokens()
                            null
                        }
                    } else {
                        tokenManager.clearTokens()
                        token = null
                    }
                }
                if (!token.isNullOrEmpty()) {
                    val biometricAuthManager = BiometricAuthManager(context)
                    val fragmentActivity = context as? FragmentActivity
                    if (fragmentActivity != null && biometricAuthManager.isBiometricEnrolled()) {
                        try {
                            val authenticated = withContext(Dispatchers.Main) {
                                biometricAuthManager.authenticate(
                                    activity = fragmentActivity,
                                    title = "Biometric Authentication",
                                    subtitle = "Verify your identity to continue"
                                )
                            }
                            if (!authenticated) {
                                tokenManager.clearTokens()
                                token = null
                            }
                        } catch (e: Exception) {
                            // On biometric failure, allow fallback to standard session check
                        }
                    }
                    if (!token.isNullOrEmpty()) {
                        try {
                            val result = exchangeRepository.getConnectionStatus()
                            if (result is com.cryptopulse.app.core.network.NetworkResult.Success) { val status = result.data; if (status.isConnected) { exchangeConnectionManager.saveConnection(status.exchangeName ?: "bybit", status.environment ?: "demo") } }
                        } catch (e: Exception) {
                            // Silently fail if not connected
                        }

                        try {
                            val botResult = botRepository.getStatus()
                            botResult.onSuccess { status ->
                                if (status.isActive || status.state == com.cryptopulse.app.domain.models.BotState.ANALYSING) {
                                    activeBotCoinId = status.coinId ?: "BTCUSDT"
                                    activeBotStrategy = status.strategy ?: "ScalperV2"
                                }
                            }
                        } catch (e: Exception) {
                            // Silently fail
                        }
                    }
                }

                val (isExchangeConnected, _, _) = exchangeConnectionManager.getConnectionInfo()
                destination = when {
                    token.isNullOrEmpty()   -> "onboarding"
                    !isExchangeConnected    -> "connect_exchange"
                    activeBotCoinId != null -> "technical_analysis"
                    else                    -> "market_candidates"
                }
            }

            val targetCoinId = activeBotCoinId
            if (targetCoinId != null) {
                tradeSessionRepository.setTradeSetupConfig(
                    TradeSetupConfig(
                        strategyId = activeBotStrategy ?: "ScalperV2",
                        symbol = targetCoinId,
                        entryPrice = 0.0
                    )
                )
            }
        } catch (e: Exception) {
            destination = "onboarding"
        }

        delay(2000)
        try {
            navController.navigate(destination) {
                popUpTo("splash") { inclusive = true }
            }
        } catch (e: Exception) {
            // Fallback navigation in case of unexpected route failure
            navController.navigate("onboarding") {
                popUpTo("splash") { inclusive = true }
            }
        }
    }

    // ── Refurbished Screen Presentation ───────────────────────────────────
    Box(
        modifier = Modifier
            .fillMaxSize()
            .testTag("splash_root")
            .background(
                Brush.verticalGradient(
                    0.0f to Color(0xFF000916),
                    0.35f to Color(0xFF000B1B),
                    0.65f to Color(0xFF000D1E),
                    1.0f to Color(0xFF000814)
                )
            )
    ) {

        // Bottom Horizon Reflection Flare (illuminating the floor)
        BottomHorizonGlow(
            modifier = Modifier
                .fillMaxWidth()
                .height(130.dp)
                .align(Alignment.BottomCenter)
                .padding(bottom = 20.dp),
            pulseGlow = pulseGlow
        )

        // Main Vertical Content Stack
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .alpha(alpha),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {

            Spacer(Modifier.weight(0.55f))

            // 1. Master Logo Mark with Northeast Arrow Vector
            Image(
                painter = painterResource(id = R.drawable.ic_cryptopulse_splash_logo),
                contentDescription = "CryptoPulse Logo",
                modifier = Modifier.size(92.dp),
                contentScale = ContentScale.Fit
            )

            Spacer(Modifier.height(16.dp))

            // 2. Wordmark: "CRYPTO" (White) + "PULSE" (Cyan)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = "CRYPTO",
                    color = Color.White,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 32.sp,
                    letterSpacing = 3.sp,
                )
                Text(
                    text = "PULSE",
                    color = Color(0xFF00B4FF),
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 32.sp,
                    letterSpacing = 3.sp,
                )
            }

            Spacer(Modifier.height(6.dp))

            // 3. Tagline: "TRADE SMART. STAY AHEAD."
            Text(
                text = "TRADE SMART. STAY AHEAD.",
                color = Color(0xFF8EA7C0),
                fontSize = 11.5.sp,
                letterSpacing = 3.2.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center
            )

            Spacer(Modifier.height(22.dp))

            // 4. Glowing Neon Heartbeat Pulse Divider
            HeartbeatPulseDivider(
                modifier = Modifier
                    .fillMaxWidth(0.68f)
                    .height(24.dp)
            )

            Spacer(Modifier.height(20.dp))

            // 5. Creator Attribution: "FOUNDED & BUILT BY" + "Shrikant Telang"
            Text(
                text = "FOUNDED & BUILT BY",
                color = Color(0xFF8EA7C0),
                fontSize = 10.5.sp,
                letterSpacing = 3.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center
            )

            Spacer(Modifier.height(6.dp))

            Text(
                text = "Shrikant Telang",
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 24.sp,
                letterSpacing = 1.2.sp,
                textAlign = TextAlign.Center
            )

            Spacer(Modifier.height(12.dp))

            // 6. Centerpiece: Golden Crypto Planetary Constellation with Dual Flares
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

            Spacer(Modifier.weight(0.9f))
        }
    }
}

/**
 * Neon-cyan heartbeat waveform divider with smooth tapering horizontal gradient wings.
 */
@Composable
internal fun HeartbeatPulseDivider(
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val cy = h / 2f

        val pulseWidth = 32.dp.toPx()
        val leftLineWidth = (w - pulseWidth) / 2f
        val pulseStartX = leftLineWidth
        val pulseEndX = leftLineWidth + pulseWidth

        // Left gradient line: transparent -> cyan
        drawLine(
            brush = Brush.horizontalGradient(
                colors = listOf(Color.Transparent, Color(0x3300B4FF), Color(0xDD00B4FF)),
                startX = 0f,
                endX = pulseStartX
            ),
            start = Offset(0f, cy),
            end = Offset(pulseStartX, cy),
            strokeWidth = 1.2.dp.toPx(),
            cap = StrokeCap.Round
        )

        // Right gradient line: cyan -> transparent
        drawLine(
            brush = Brush.horizontalGradient(
                colors = listOf(Color(0xDD00B4FF), Color(0x3300B4FF), Color.Transparent),
                startX = pulseEndX,
                endX = w
            ),
            start = Offset(pulseEndX, cy),
            end = Offset(w, cy),
            strokeWidth = 1.2.dp.toPx(),
            cap = StrokeCap.Round
        )

        // Pulse waveform path
        val path = Path().apply {
            moveTo(pulseStartX, cy)
            lineTo(pulseStartX + pulseWidth * 0.20f, cy)
            lineTo(pulseStartX + pulseWidth * 0.32f, cy + 4.dp.toPx())
            lineTo(pulseStartX + pulseWidth * 0.46f, cy - 11.dp.toPx())
            lineTo(pulseStartX + pulseWidth * 0.60f, cy + 12.dp.toPx())
            lineTo(pulseStartX + pulseWidth * 0.74f, cy - 4.dp.toPx())
            lineTo(pulseStartX + pulseWidth * 0.86f, cy)
            lineTo(pulseEndX, cy)
        }

        // Soft outer glow stroke
        drawPath(
            path = path,
            color = Color(0x5500B4FF),
            style = Stroke(width = 4.2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        )

        // Core cyan stroke
        drawPath(
            path = path,
            color = Color(0xFF00B4FF),
            style = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        )
    }
}

/**
 * Horizon reflection flare illuminating the bottom floor of the screen.
 */
@Composable
private fun BottomHorizonGlow(
    modifier: Modifier = Modifier,
    pulseGlow: Float = 1f,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val center = Offset(w / 2f, h * 0.70f)

        // Outer ambient diffuse blue aura
        drawOval(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color(0x550084FF),
                    Color(0x220055CC),
                    Color.Transparent
                ),
                center = center,
                radius = w * 0.45f * pulseGlow
            ),
            topLeft = Offset(center.x - w * 0.45f * pulseGlow, center.y - 35.dp.toPx()),
            size = Size(w * 0.90f * pulseGlow, 70.dp.toPx())
        )

        // Bright cyan horizon core
        drawOval(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color(0xFFB5EFFF),
                    Color(0xEE00B4FF),
                    Color(0x660066FF),
                    Color.Transparent
                ),
                center = center,
                radius = w * 0.22f * pulseGlow
            ),
            topLeft = Offset(center.x - w * 0.22f * pulseGlow, center.y - 7.dp.toPx()),
            size = Size(w * 0.44f * pulseGlow, 14.dp.toPx())
        )
    }
}






