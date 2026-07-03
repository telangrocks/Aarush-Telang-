package com.cryptopulse.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Draws the CryptoPulse "C with heartbeat" logo icon in code.
 *
 * Renders:
 *  – A circular arc (the "C" shape) with a cyan gradient
 *  – A simplified heartbeat / pulse line through the centre
 *  – Small pixel-dot trail on the open end
 */
@Composable
fun CryptoPulseLogoIcon(
    modifier: Modifier = Modifier,
    size: Dp = 36.dp,
    primaryColor: Color = Color(0xFF00B4FF),
    accentColor: Color = Color(0xFF1A6FFF),
) {
    Canvas(modifier = modifier.size(size)) {
        val s = this.size.minDimension
        val cx = s / 2f
        val cy = s / 2f
        val radius = s * 0.44f
        val strokeW = s * 0.095f

        val arcBrush = Brush.sweepGradient(
            colors = listOf(primaryColor, accentColor, primaryColor),
            center = Offset(cx, cy)
        )

        // Arc — 300° sweep (leaves a gap at top-right like the reference "C")
        drawArc(
            brush = arcBrush,
            startAngle = 120f,
            sweepAngle = 300f,
            useCenter = false,
            style = Stroke(width = strokeW, cap = StrokeCap.Round),
        )

        // Heartbeat / ECG line through centre
        val mid = cy
        val segW = s * 0.12f
        val peak = s * 0.22f
        val lineStroke = strokeW * 0.45f

        drawLine(color = Color.White, start = Offset(cx - segW * 2.2f, mid), end = Offset(cx - segW * 0.8f, mid), strokeWidth = lineStroke, cap = StrokeCap.Round)
        drawLine(color = Color.White, start = Offset(cx - segW * 0.8f, mid), end = Offset(cx - segW * 0.2f, mid - peak), strokeWidth = lineStroke, cap = StrokeCap.Round)
        drawLine(color = Color.White, start = Offset(cx - segW * 0.2f, mid - peak), end = Offset(cx + segW * 0.4f, mid + peak * 0.6f), strokeWidth = lineStroke, cap = StrokeCap.Round)
        drawLine(color = Color.White, start = Offset(cx + segW * 0.4f, mid + peak * 0.6f), end = Offset(cx + segW * 1f, mid), strokeWidth = lineStroke, cap = StrokeCap.Round)
        drawLine(color = Color.White, start = Offset(cx + segW * 1f, mid), end = Offset(cx + segW * 2.2f, mid), strokeWidth = lineStroke, cap = StrokeCap.Round)

        // Pixel dot trail (top-right gap)
        val dotR = strokeW * 0.28f
        val dotSp = strokeW * 0.75f
        val tx = cx + radius * 0.72f
        val ty = cy - radius * 0.72f
        for (i in 0..3) {
            drawCircle(
                color = primaryColor.copy(alpha = 1f - i * 0.22f),
                radius = dotR * (1f - i * 0.18f),
                center = Offset(tx + i * dotSp, ty - i * dotSp * 0.5f)
            )
        }
    }
}
