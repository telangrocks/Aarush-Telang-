package com.cryptopulse.app.data.mapper.exchange

import com.cryptopulse.app.data.api.dto.exchange.response.BalanceItemDataDto
import com.cryptopulse.app.domain.models.BalanceItem

fun BalanceItemDataDto.toDomain(): BalanceItem {
    val a = asset?.takeIf { it.isNotBlank() } ?: currency?.takeIf { it.isNotBlank() } ?: "UNKNOWN"
    val f = free?.takeIf { !it.isNaN() && !it.isInfinite() }?.coerceAtLeast(0.0) ?: 0.0
    val l = locked?.takeIf { !it.isNaN() && !it.isInfinite() }?.coerceAtLeast(0.0) ?: 0.0
    val u = used?.takeIf { !it.isNaN() && !it.isInfinite() }?.coerceAtLeast(0.0) ?: l
    val t = total?.takeIf { !it.isNaN() && !it.isInfinite() }?.coerceAtLeast(0.0) ?: (f + l)
    return BalanceItem(
        asset = a,
        free = f,
        locked = l,
        used = u,
        total = t
    )
}
