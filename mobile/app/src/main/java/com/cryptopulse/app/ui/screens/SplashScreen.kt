package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*


import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.cryptopulse.app.domain.repository.AuthRepository
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.repository.ExchangeRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.domain.models.TradeSetupConfig
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.data.local.BiometricAuthManager
import com.cryptopulse.app.ui.components.CryptoPulseLogoIcon
import com.cryptopulse.app.ui.theme.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.fragment.app.FragmentActivity

/**
 * Splash screen matching the reference design:
 *  – Deep navy gradient background
 *  – CryptoPulse logo + "CRYPTOPULSE" wordmark + tagline
 *  – "CRAFTED BY / SHRIKANT TELANG" section
 *  – Animated city skyline with floating crypto coin glyphs
 *  – Full fade-in over 1.8 s, auto-navigates after 3.5 s
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

    // Pulse glow for the city skyline radial light
    val glowAnim = rememberInfiniteTransition(label = "glow")
    val glowRadius by glowAnim.animateFloat(
        initialValue = 0.28f,
        targetValue  = 0.35f,
        animationSpec = infiniteRepeatable(
            animation  = tween(1800, easing = EaseInOut),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "glow_radius"
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

    // ── Background ────────────────────────────────────────────────────────
    Box(
        modifier = Modifier
            .fillMaxSize()
            .testTag("splash_root")
            .background(
                Brush.verticalGradient(
                    listOf(NavyDeep, NavyDark, Color(0xFF071020))
                )
            )
    ) {

        // Ambient radial light glow at center-bottom
        AmbientGlowBackground(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.50f)
                .align(Alignment.BottomCenter),
            glowRadiusFraction = glowRadius
        )

        // ── Main content, centred in the upper ~58% ───────────────────────
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.65f)
                .align(Alignment.TopCenter)
                .alpha(alpha)
                .padding(horizontal = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {

            // Refurbished Master Logo Mark
            CryptoPulseLogoIcon(size = 96.dp)

            Spacer(Modifier.height(20.dp))

            // CRYPTOPULSE wordmark
            Row {
                Text(
                    text = "CRYPTO",
                    color = Color.White,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 30.sp,
                    letterSpacing = 3.sp,
                )
                Text(
                    text = "PULSE",
                    color = CyanPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 30.sp,
                    letterSpacing = 3.sp,
                )
            }

            Spacer(Modifier.height(6.dp))

            // Tagline
            Text(
                text = "TRADE SMART. STAY AHEAD.",
                color = TextSecondary,
                fontSize = 11.sp,
                letterSpacing = 2.5.sp,
                fontWeight = FontWeight.Medium,
            )

            Spacer(Modifier.height(36.dp))

            // Separator + "FOUNDED BY"
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Box(Modifier.width(40.dp).height(1.dp).background(NavyBorder))
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "FOUNDED BY",
                    color = TextMuted,
                    fontSize = 9.sp,
                    letterSpacing = 2.sp,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.width(10.dp))
                Box(Modifier.width(40.dp).height(1.dp).background(NavyBorder))
            }

            Spacer(Modifier.height(8.dp))

            // Founder Name
            Text(
                text = "Shrikant Telang",
                color = TextPrimary,
                fontWeight = FontWeight.Bold,
                fontSize = 19.sp,
                letterSpacing = 2.sp,
            )

            Spacer(Modifier.height(8.dp))

            // Diamond bullet
            Text(text = "◆", color = CyanPrimary, fontSize = 9.sp)
        }
    }
}

/**
 * Ambient background glow for a refined, premium launch entrance.
 */
@Composable
private fun AmbientGlowBackground(
    modifier: Modifier,
    glowRadiusFraction: Float,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height

        val glowCenter = Offset(w / 2f, h * 0.40f)
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color(0x3300B4FF),
                    Color(0x1100B4FF),
                    Color.Transparent,
                ),
                center = glowCenter,
                radius = w * glowRadiusFraction * 1.5f,
            ),
            radius = w * glowRadiusFraction * 1.5f,
            center = glowCenter,
        )
    }
}





