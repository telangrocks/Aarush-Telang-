package com.cryptopulse.app.data.mapper.exchange

import com.cryptopulse.app.data.api.dto.exchange.response.BalanceItemDataDto
import com.cryptopulse.app.domain.models.BalanceItem

fun BalanceItemDataDto.toDomain(): BalanceItem = BalanceItem(
    asset = asset,
    free = free,
    locked = locked,
    total = total
)
