package com.cryptopulse.app.ui.screens

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.cryptopulse.app.ui.components.CryptoPulseLogoIcon
import com.cryptopulse.app.ui.theme.*
import kotlinx.coroutines.delay

@Composable
fun WelcomeScreen(navController: NavController) {
    var visible by remember { mutableStateOf(false) }

    val alpha by animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = tween(durationMillis = 1800, easing = EaseInOut),
        label = "welcome_fade"
    )

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

    LaunchedEffect(Unit) {
        visible = true
        delay(2500)
        navController.popBackStack()
        navController.navigate("onboarding")
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(NavyDeep, NavyDark, Color(0xFF071020))
                )
            )
    ) {
        CitySkylinesBackground(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.48f)
                .align(Alignment.BottomCenter),
            glowRadiusFraction = glowRadius
        )

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
            CryptoPulseLogoIcon(size = 86.dp)

            Spacer(Modifier.height(18.dp))

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

            Text(
                text = "TRADE SMART. STAY AHEAD.",
                color = TextSecondary,
                fontSize = 11.sp,
                letterSpacing = 2.5.sp,
                fontWeight = FontWeight.Medium,
            )

            Spacer(Modifier.height(36.dp))

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

            Text(
                text = "SHRIKANT TELANG",
                color = TextPrimary,
                fontWeight = FontWeight.ExtraBold,
                fontSize = 20.sp,
                letterSpacing = 3.sp,
            )

            Spacer(Modifier.height(8.dp))

            Text(text = "◆", color = CyanPrimary, fontSize = 10.sp)
        }
    }
}

@Composable
private fun CitySkylinesBackground(
    modifier: Modifier,
    glowRadiusFraction: Float,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height

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

        val buildingColor = Color(0xFF071428)
        val buildingAccent = Color(0x4400B4FF)

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
            drawLine(
                color = buildingAccent,
                start = Offset(bx + bw * 0.3f, by + bh * 0.1f),
                end   = Offset(bx + bw * 0.3f, by + bh * 0.5f),
                strokeWidth = 1f,
            )
        }

        val coinPositions = listOf(
            Offset(w * 0.08f, h * 0.35f),
            Offset(w * 0.20f, h * 0.55f),
            Offset(w * 0.50f, h * 0.08f),
            Offset(w * 0.78f, h * 0.42f),
            Offset(w * 0.90f, h * 0.22f),
        )
        val coinRadii = listOf(18f, 14f, 30f, 16f, 13f)
        val coinColors = listOf(
            Color(0xFFF7931A),
            Color(0xFF627EEA),
            Color(0xFFF7931A),
            Color(0xFFF3BA2F),
            Color(0xFF9945FF),
        )

        for (i in coinPositions.indices) {
            val c = coinPositions[i]
            val r = coinRadii[i]
            val col = coinColors[i]
            drawCircle(color = col.copy(alpha = 0.15f), radius = r * 1.7f, center = c)
            drawCircle(color = col.copy(alpha = 0.55f), radius = r, center = c, style = Stroke(width = 1.5f))
        }

        val ring = coinPositions[2]
        drawCircle(color = Color(0x2200B4FF), radius = coinRadii[2] * 2.5f, center = ring, style = Stroke(1f))
        drawCircle(color = Color(0x1100B4FF), radius = coinRadii[2] * 3.5f, center = ring, style = Stroke(1f))
    }
}
