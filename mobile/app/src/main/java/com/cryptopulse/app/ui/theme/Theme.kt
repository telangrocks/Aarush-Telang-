package com.cryptopulse.app.ui.theme

import android.app.Activity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

// ─── Always dark — crypto apps don't use light mode ───────────────────────
private val CryptoPulseDarkScheme = darkColorScheme(
    primary          = CyanPrimary,
    onPrimary        = Color.White,
    primaryContainer = NavyMid,
    secondary        = BlueMid,
    onSecondary      = Color.White,
    tertiary         = ProfitGreen,
    onTertiary       = NavyDeep,
    error            = LossRed,
    onError          = Color.White,
    background       = NavyDark,
    onBackground     = TextPrimary,
    surface          = NavyCard,
    onSurface        = TextPrimary,
    surfaceVariant   = NavyMid,
    onSurfaceVariant = TextSecondary,
    outline          = NavyBorder,
)

@Composable
fun CryptoPulseTheme(content: @Composable () -> Unit) {
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = NavyDeep.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = false
        }
    }

    MaterialTheme(
        colorScheme = CryptoPulseDarkScheme,
        typography  = Typography,
        content     = content
    )
}
