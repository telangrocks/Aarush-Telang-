package com.cryptopulse.app.ui.screens

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
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.data.local.BiometricAuthManager
import com.cryptopulse.app.ui.components.CryptoPulseLogoIcon
import com.cryptopulse.app.ui.theme.*
import kotlinx.coroutines.delay
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
    exchangeService: com.cryptopulse.app.data.api.ExchangeService
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
        var token = tokenManager.getToken()
        if (tokenManager.isTokenExpired(token)) {
            tokenManager.clearTokens()
            token = null
        }
        if (!token.isNullOrEmpty()) {
            val biometricAuthManager = BiometricAuthManager(context)
            // Only attempt biometric auth if the host is a FragmentActivity,
            // otherwise BiometricPrompt would throw a ClassCastException.
            val fragmentActivity = context as? FragmentActivity
            if (fragmentActivity != null && biometricAuthManager.isBiometricEnrolled()) {
                try {
                    val authenticated = biometricAuthManager.authenticate(
                        activity = fragmentActivity,
                        title = "Biometric Authentication",
                        subtitle = "Verify your identity to continue"
                    )
                    if (!authenticated) {
                        tokenManager.clearTokens()
                        token = null
                    }
                } catch (e: Exception) {
                    tokenManager.clearTokens()
                    token = null
                }
            }
            try {
                val response = exchangeService.getStatus()
                if (response.isSuccessful && response.body() != null) {
                    val status = response.body()!!
                    if (status.isConnected) {
                        exchangeConnectionManager.saveConnection(
                            status.exchangeName ?: "binance",
                            status.environment ?: "testnet"
                        )
                    } else {
                        exchangeConnectionManager.clearConnection()
                    }
                }
            } catch (e: Exception) {
                // Ignore status sync errors to allow offline start with cached credentials
            }
        }
        delay(3500)
        val (isExchangeConnected, _, _) = exchangeConnectionManager.getConnectionInfo()
        val destination = when {
            token.isNullOrEmpty() -> "welcome"
            isExchangeConnected -> "market_candidates"
            else -> "connect_exchange"
        }
        navController.navigate(destination) {
            popUpTo("splash") { inclusive = true }
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

        // Bottom city skyline illustration drawn on Canvas
        CitySkylinesBackground(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.48f)
                .align(Alignment.BottomCenter),
            glowRadiusFraction = glowRadius
        )

        // ── Main content, centred in the upper ~55% ───────────────────────
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.60f)
                .align(Alignment.TopCenter)
                .alpha(alpha)
                .padding(horizontal = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {

            // Logo icon
            CryptoPulseLogoIcon(size = 86.dp)

            Spacer(Modifier.height(18.dp))

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

            // Separator + "CRAFTED BY"
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Box(Modifier.width(40.dp).height(1.dp).background(NavyBorder))
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "CRAFTED BY",
                    color = TextMuted,
                    fontSize = 9.sp,
                    letterSpacing = 2.sp,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.width(10.dp))
                Box(Modifier.width(40.dp).height(1.dp).background(NavyBorder))
            }

            Spacer(Modifier.height(8.dp))

            // Creator name
            Text(
                text = "SHRIKANT TELANG",
                color = TextPrimary,
                fontWeight = FontWeight.ExtraBold,
                fontSize = 20.sp,
                letterSpacing = 3.sp,
            )

            Spacer(Modifier.height(8.dp))

            // Diamond bullet
            Text(text = "◆", color = CyanPrimary, fontSize = 10.sp)
        }
    }
}

/**
 * Canvas-drawn cyberpunk city skyline with a radial glow and floating coin glyphs.
 */
@Composable
private fun CitySkylinesBackground(
    modifier: Modifier,
    glowRadiusFraction: Float,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height

        // Radial glow at horizon
        val glowCenter = Offset(w / 2f, h * 0.18f)
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color(0x5500B4FF),
                    Color(0x2200B4FF),
                    Color.Transparent,
                ),
                center = glowCenter,
                radius = w * glowRadiusFraction,
            ),
            radius = w * glowRadiusFraction,
            center = glowCenter,
        )

        // Skyline silhouette (simple building shapes in navy-dark)
        val buildingColor = Color(0xFF071428)
        val buildingAccent = Color(0x4400B4FF)

        // Building profiles — (x_frac, width_frac, height_frac)
        val buildings = listOf(
            Triple(0.0f,  0.12f, 0.55f),
            Triple(0.10f, 0.08f, 0.72f),
            Triple(0.17f, 0.06f, 0.45f),
            Triple(0.22f, 0.14f, 0.85f),
            Triple(0.35f, 0.09f, 0.60f),
            Triple(0.43f, 0.14f, 0.95f),
            Triple(0.56f, 0.10f, 0.75f),
            Triple(0.65f, 0.07f, 0.50f),
            Triple(0.71f, 0.16f, 0.88f),
            Triple(0.86f, 0.08f, 0.62f),
            Triple(0.93f, 0.07f, 0.42f),
        )

        for ((xf, wf, hf) in buildings) {
            val bx = w * xf
            val bw = w * wf
            val bh = h * hf
            val by = h - bh
            drawRect(color = buildingColor, topLeft = Offset(bx, by), size = androidx.compose.ui.geometry.Size(bw, bh))
            // Window glow lines
            drawLine(
                color = buildingAccent,
                start = Offset(bx + bw * 0.3f, by + bh * 0.1f),
                end   = Offset(bx + bw * 0.3f, by + bh * 0.5f),
                strokeWidth = 1f,
            )
        }

        // Floating coin circle glyph positions (centre of screen, scattered)
        val coinPositions = listOf(
            Offset(w * 0.08f, h * 0.35f),   // BTC left
            Offset(w * 0.20f, h * 0.55f),   // ETH
            Offset(w * 0.50f, h * 0.08f),   // BTC centre (large)
            Offset(w * 0.78f, h * 0.42f),   // BNB right
            Offset(w * 0.90f, h * 0.22f),   // SOL top-right
        )
        val coinRadii = listOf(18f, 14f, 30f, 16f, 13f)
        val coinColors = listOf(
            Color(0xFFF7931A), // BTC orange
            Color(0xFF627EEA), // ETH purple
            Color(0xFFF7931A), // BTC orange (large)
            Color(0xFFF3BA2F), // BNB gold
            Color(0xFF9945FF), // SOL purple
        )
        val coinLabels = listOf("₿", "Ξ", "₿", "B", "S")

        for (i in coinPositions.indices) {
            val c = coinPositions[i]
            val r = coinRadii[i]
            val col = coinColors[i]
            // Outer glow
            drawCircle(color = col.copy(alpha = 0.15f), radius = r * 1.7f, center = c)
            // Circle border
            drawCircle(color = col.copy(alpha = 0.55f), radius = r, center = c, style = Stroke(width = 1.5f))
        }

        // Circular targeting ring around centre BTC
        val ring = coinPositions[2]
        drawCircle(color = Color(0x2200B4FF), radius = coinRadii[2] * 2.5f, center = ring, style = Stroke(1f))
        drawCircle(color = Color(0x1100B4FF), radius = coinRadii[2] * 3.5f, center = ring, style = Stroke(1f))
    }
}
