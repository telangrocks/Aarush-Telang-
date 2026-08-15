package com.cryptopulse.app.ui.utils

import java.util.Locale

object Formatters {
    private val DefaultLocale = Locale.US

    fun formatCryptoPrice(price: Double): String {
        if (price.isNaN() || price.isInfinite() || price <= 0.0) return "--"
        return when {
            price >= 1.0 -> String.format(DefaultLocale, "%.2f", price)
            price >= 0.01 -> String.format(DefaultLocale, "%.4f", price)
            else -> String.format(DefaultLocale, "%.8f", price).trimEnd('0').removeSuffix(".")
        }
    }

    fun formatQuoteVolume(volume: Double): String {
        if (volume.isNaN() || volume.isInfinite() || volume <= 0.0) return "$0.0M"
        return when {
            volume >= 1.0e12 -> String.format(DefaultLocale, "$%.2fT", volume / 1.0e12)
            volume >= 1.0e9 -> String.format(DefaultLocale, "$%.2fB", volume / 1.0e9)
            volume >= 1.0e6 -> String.format(DefaultLocale, "$%.2fM", volume / 1.0e6)
            volume >= 1.0e3 -> String.format(DefaultLocale, "$%.1fK", volume / 1.0e3)
            else -> String.format(DefaultLocale, "$%.2f", volume)
        }
    }

    fun formatPercentage(percent: Double): String {
        if (percent.isNaN() || percent.isInfinite()) return "+0.00%"
        val sanitized = if (percent == -0.0) 0.0 else percent
        val sign = if (sanitized >= 0) "+" else ""
        return String.format(DefaultLocale, "%s%.2f%%", sign, sanitized)
    }

    fun formatScore(score: Double): String {
        if (score.isNaN() || score.isInfinite() || score <= 0.0) return "0.0"
        return String.format(DefaultLocale, "%.1f", score)
    }

    fun formatMinNotional(amount: Double): String {
        if (amount.isNaN() || amount.isInfinite() || amount <= 0.0) return "$0.00"
        return String.format(DefaultLocale, "$%.2f", amount)
    }

    fun formatConstraint(value: Double): String {
        return if (value == value.toLong().toDouble()) {
            value.toLong().toString()
        } else {
            java.math.BigDecimal.valueOf(value).stripTrailingZeros().toPlainString()
        }
    }
}
