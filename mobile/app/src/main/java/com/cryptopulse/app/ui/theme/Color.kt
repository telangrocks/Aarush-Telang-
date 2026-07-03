package com.cryptopulse.app.ui.theme

import androidx.compose.ui.graphics.Color

// ─── Deep Navy Brand Palette ───────────────────────────────────────────────
val NavyDeep       = Color(0xFF050D1F)   // darkest background
val NavyDark       = Color(0xFF0A1628)   // primary background
val NavyMid        = Color(0xFF0D1F3C)   // slightly lighter surface
val NavyCard       = Color(0xFF0F1E35)   // card background
val NavyBorder     = Color(0xFF1A3057)   // subtle border

// ─── Cyan / Blue Brand Accents ─────────────────────────────────────────────
val CyanPrimary    = Color(0xFF00B4FF)   // main accent (logo / headings)
val CyanLight      = Color(0xFF40D0FF)   // lighter cyan for gradient starts
val CyanGlow       = Color(0x3300B4FF)   // translucent glow
val BluePrimary    = Color(0xFF1565C0)   // deep blue
val BlueMid        = Color(0xFF2979FF)   // CTA blue mid
val PurpleAccent   = Color(0xFF6C31D7)   // CTA button gradient end

// ─── Gradient helpers (solid stops — use with Brush.horizontalGradient) ──
val GradientStart  = Color(0xFF1A6FFF)
val GradientEnd    = Color(0xFF7B2FE0)

// ─── Status / P&L Colors ──────────────────────────────────────────────────
val ProfitGreen    = Color(0xFF00E676)   // take profit, positive P&L
val LossRed        = Color(0xFFFF3D57)   // stop loss, negative P&L
val WarningOrange  = Color(0xFFFFAB40)   // neutral warnings

// ─── Text Colors ──────────────────────────────────────────────────────────
val TextPrimary    = Color(0xFFE8F0FF)   // almost-white for primary labels
val TextSecondary  = Color(0xFF6A84A8)   // muted labels / subtitles
val TextMuted      = Color(0xFF3A5478)   // very muted, hints

// ─── Legacy aliases (kept so nothing breaks) ──────────────────────────────
val DarkGray       = NavyDeep
val CardGray       = NavyCard
val LightGray      = TextSecondary
val NeonGreen      = ProfitGreen
val NeonRed        = LossRed
val CryptoBlue     = CyanPrimary

// Material3 compat names used by the old theme
val Purple80       = Color(0xFFD0BCFF)
val PurpleGrey80   = Color(0xFFCCC2DC)
val Pink80         = Color(0xFFEFB8C8)
val Purple40       = Color(0xFF6650a4)
val PurpleGrey40   = Color(0xFF625b71)
val Pink40         = Color(0xFF7D5260)
