package com.cryptopulse.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// ─── Font family ──────────────────────────────────────────────────────────
// We rely on the system sans-serif with wide letter-spacing overrides to
// achieve the reference's wide-tracked, geometric feel — no external font
// download needed, and nothing breaks the build.
val SystemSans = FontFamily.SansSerif

// ─── Typography scale matching the reference designs ──────────────────────
val Typography = Typography(
    // Page titles like "VALIDATE API KEYS", "TOP 10 SHORTLISTED CANDIDATES"
    displayLarge = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.ExtraBold,
        fontSize     = 26.sp,
        lineHeight   = 32.sp,
        letterSpacing = 2.sp,
    ),
    // Screen-level hero headings
    displayMedium = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.Bold,
        fontSize     = 22.sp,
        lineHeight   = 28.sp,
        letterSpacing = 1.5.sp,
    ),
    // Section card headings ("ENTER API KEYS", "CALCULATION SUMMARY")
    displaySmall = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.Bold,
        fontSize     = 14.sp,
        lineHeight   = 20.sp,
        letterSpacing = 1.2.sp,
    ),
    // Coin pair names ("SOL/USDT")
    headlineLarge = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.ExtraBold,
        fontSize     = 20.sp,
        lineHeight   = 26.sp,
        letterSpacing = 0.5.sp,
    ),
    // Top app bar title
    headlineMedium = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.Bold,
        fontSize     = 18.sp,
        lineHeight   = 24.sp,
        letterSpacing = 0.5.sp,
    ),
    headlineSmall = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.SemiBold,
        fontSize     = 16.sp,
        lineHeight   = 22.sp,
        letterSpacing = 0.5.sp,
    ),
    // Body text in info rows
    bodyLarge = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.Normal,
        fontSize     = 15.sp,
        lineHeight   = 22.sp,
        letterSpacing = 0.25.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.Normal,
        fontSize     = 13.sp,
        lineHeight   = 20.sp,
        letterSpacing = 0.25.sp,
    ),
    // Small muted helper text, subtitles
    bodySmall = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.Normal,
        fontSize     = 11.sp,
        lineHeight   = 16.sp,
        letterSpacing = 0.4.sp,
    ),
    // Button labels
    labelLarge = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.Bold,
        fontSize     = 15.sp,
        lineHeight   = 20.sp,
        letterSpacing = 1.sp,
    ),
    // Table headers, uppercase small labels
    labelSmall = TextStyle(
        fontFamily   = SystemSans,
        fontWeight   = FontWeight.Medium,
        fontSize     = 10.sp,
        lineHeight   = 14.sp,
        letterSpacing = 0.8.sp,
    ),
)
