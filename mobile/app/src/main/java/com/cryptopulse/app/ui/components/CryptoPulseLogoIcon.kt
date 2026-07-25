package com.cryptopulse.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Modern, futuristic CryptoPulse logo icon rendered natively in Compose Canvas.
 * Features multi-layer neon glowing gradients, a stylized geometric emblem,
 * a sharp ECG pulse wave, and diamond crypto accent nodes.
 */
@Composable
fun CryptoPulseLogoIcon(
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    primaryColor: Color = Color(0xFF00F0FF),
    accentColor: Color = Color(0xFF7000FF),
    secondaryColor: Color = Color(0xFF00FF9D),
) {
    Canvas(modifier = modifier.size(size)) {
        val s = this.size.minDimension
        val cx = s / 2f
        val cy = s / 2f
        val radius = s * 0.42f
        val strokeW = s * 0.085f

        // 1. Outer Soft Glow Aura
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    primaryColor.copy(alpha = 0.35f),
                    accentColor.copy(alpha = 0.15f),
                    Color.Transparent
                ),
                center = Offset(cx, cy),
                radius = s * 0.55f
            ),
            radius = s * 0.55f,
            center = Offset(cx, cy)
        )

        // 2. Futuristic Hexagonal Rounded Container / Ring
        val ringPath = Path().apply {
            val cornerR = s * 0.16f
            addRoundRect(
                RoundRect(
                    left = cx - radius,
                    top = cy - radius,
                    right = cx + radius,
                    bottom = cy + radius,
                    cornerRadius = CornerRadius(cornerR, cornerR)
                )
            )
        }

        val borderGradient = Brush.sweepGradient(
            colors = listOf(primaryColor, accentColor, secondaryColor, primaryColor),
            center = Offset(cx, cy)
        )

        drawPath(
            path = ringPath,
            brush = borderGradient,
            style = Stroke(width = strokeW, cap = StrokeCap.Round, join = StrokeJoin.Round)
        )

        // 3. Inner Glowing "C" Arc
        val arcBrush = Brush.linearGradient(
            colors = listOf(primaryColor, Color.White, accentColor),
            start = Offset(cx - radius * 0.6f, cy - radius * 0.6f),
            end = Offset(cx + radius * 0.6f, cy + radius * 0.6f)
        )

        drawArc(
            brush = arcBrush,
            startAngle = 135f,
            sweepAngle = 270f,
            useCenter = false,
            style = Stroke(width = strokeW * 0.65f, cap = StrokeCap.Round),
            size = Size(radius * 1.5f, radius * 1.5f),
            topLeft = Offset(cx - radius * 0.75f, cy - radius * 0.75f)
        )

        // 4. Central Electric Heartbeat / Pulse Wave
        val pulsePath = Path().apply {
            val startX = cx - radius * 0.65f
            val endX = cx + radius * 0.65f
            val segmentW = (endX - startX) / 6f
            val peakHigh = cy - radius * 0.38f
            val peakLow = cy + radius * 0.28f

            moveTo(startX, cy)
            lineTo(startX + segmentW * 1.5f, cy)
            lineTo(startX + segmentW * 2.3f, peakHigh)
            lineTo(startX + segmentW * 3.4f, peakLow)
            lineTo(startX + segmentW * 4.2f, cy - radius * 0.1f)
            lineTo(startX + segmentW * 4.8f, cy)
            lineTo(endX, cy)
        }

        // Pulse Glow Shadow
        drawPath(
            path = pulsePath,
            color = primaryColor.copy(alpha = 0.5f),
            style = Stroke(width = strokeW * 0.9f, cap = StrokeCap.Round, join = StrokeJoin.Round)
        )

        // Core Pulse White Line
        drawPath(
            path = pulsePath,
            brush = Brush.horizontalGradient(
                colors = listOf(primaryColor, Color.White, secondaryColor),
                startX = cx - radius,
                endX = cx + radius
            ),
            style = Stroke(width = strokeW * 0.45f, cap = StrokeCap.Round, join = StrokeJoin.Round)
        )

        // 5. Diamond Sparkle at Peak
        val peakX = cx - radius * 0.65f + ((cx + radius * 0.65f) - (cx - radius * 0.65f)) / 6f * 2.3f
        val peakY = cy - radius * 0.38f
        val diamondSize = strokeW * 0.6f

        val diamondPath = Path().apply {
            moveTo(peakX, peakY - diamondSize)
            lineTo(peakX + diamondSize * 0.7f, peakY)
            lineTo(peakX, peakY + diamondSize)
            lineTo(peakX - diamondSize * 0.7f, peakY)
            close()
        }

        drawPath(path = diamondPath, color = Color.White)
        drawCircle(color = primaryColor, radius = diamondSize * 1.2f, center = Offset(peakX, peakY), style = Stroke(1.5f))

        // 6. Cyber Dot Node at End
        val endX = cx + radius * 0.65f
        drawCircle(color = secondaryColor, radius = strokeW * 0.35f, center = Offset(endX, cy))
        drawCircle(color = Color.White, radius = strokeW * 0.18f, center = Offset(endX, cy))
    }
}
