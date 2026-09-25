package com.cryptopulse.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.domain.models.TradeExecutionResult
import java.text.NumberFormat
import java.util.Locale

/**
 * World-class execution confirmation card for exchange executions (Bybit).
 * Refurbished to match the reference cyber-terminal visual design language.
 */
@Suppress("UNUSED_PARAMETER")
@Composable
fun TradeExecutionConfirmationCard(
    result: TradeExecutionResult,
    onViewCandidates: () -> Unit,
    onDismiss: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    val priceFormatter = remember {
        NumberFormat.getNumberInstance(Locale.US).apply {
            minimumFractionDigits = 2
            maximumFractionDigits = 6
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 2.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        // Outer Cyber Halo Card Container
        TradeExecutedOuterHaloCard {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 20.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Concentric Success Badge
                TradeExecutedSuccessBadge()

                Spacer(modifier = Modifier.height(18.dp))

                // Inner Cyber Card with the 6 required rows in exact sequence
                TradeExecutedInnerCard {
                    // 1. Ticker Name
                    ExecutionDetailRow(
                        label = "Ticker Name",
                        value = result.symbol,
                        valueColor = Color.White,
                        testTag = "trade_executed_symbol"
                    )
                    HorizontalDivider(color = Color(0x22142B47), thickness = 0.8.dp)

                    // 2. Order ID (Strictly result.orderId, NO fallback to positionId, full untruncated string)
                    ExecutionDetailRow(
                        label = "Order ID",
                        value = result.orderId,
                        valueColor = Color.White,
                        testTag = "trade_executed_order_id"
                    )
                    HorizontalDivider(color = Color(0x22142B47), thickness = 0.8.dp)

                    // 3. Entry Price
                    ExecutionDetailRow(
                        label = "Entry Price",
                        value = "$${priceFormatter.format(result.actualFillPrice)}",
                        valueColor = Color.White,
                        testTag = "trade_executed_entry"
                    )
                    HorizontalDivider(color = Color(0x22142B47), thickness = 0.8.dp)

                    // 4. Stop Loss
                    ExecutionDetailRow(
                        label = "Stop Loss",
                        value = "$${priceFormatter.format(result.stopLoss)}",
                        valueColor = Color(0xFFFF3D57),
                        testTag = "trade_executed_stop_loss"
                    )
                    HorizontalDivider(color = Color(0x22142B47), thickness = 0.8.dp)

                    // 5. Take Profit
                    ExecutionDetailRow(
                        label = "Take Profit",
                        value = "$${priceFormatter.format(result.takeProfit)}",
                        valueColor = Color(0xFF00FFA3),
                        testTag = "trade_executed_take_profit"
                    )
                    HorizontalDivider(color = Color(0x22142B47), thickness = 0.8.dp)

                    // 6. Estimated P&L
                    val pnlSign = if (result.estimatedPnl >= 0) "+" else ""
                    val pnlColor = if (result.estimatedPnl >= 0) Color(0xFF00FFA3) else Color(0xFFFF3D57)
                    ExecutionDetailRow(
                        label = "Estimated P&L",
                        value = "$pnlSign$${"%.2f".format(result.estimatedPnl)}",
                        valueColor = pnlColor,
                        testTag = "trade_executed_estimated_pnl"
                    )
                }

                Spacer(modifier = Modifier.height(20.dp))

                // CTA Button: VIEW TOP 10 OPPORTUNITIES
                TradeExecutedCtaButton(
                    text = "VIEW TOP 10 OPPORTUNITIES",
                    onClick = onViewCandidates
                )
            }
        }

        // Bottom ambient horizon cyan glow
        TradeExecutedBottomHorizonGlow()
    }
}

/**
 * Outer card container with ambient top cyan halo, rounded corners, and glowing gradient border.
 */
@Composable
private fun TradeExecutedOuterHaloCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) {
    val cardRadius = 24.dp
    val borderBrush = Brush.verticalGradient(
        listOf(
            Color(0xFF00B4FF),
            Color(0xFF0077E6),
            Color(0xFF0044AA),
        )
    )

    Box(
        modifier = modifier
            .fillMaxWidth()
            .drawBehind {
                // Top ambient cyan halo flare
                drawOval(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color(0x3500B4FF),
                            Color(0x150077FE),
                            Color.Transparent
                        ),
                        center = Offset(size.width / 2f, 0f),
                        radius = size.width * 0.45f
                    )
                )
            }
            .clip(RoundedCornerShape(cardRadius))
            .background(
                Brush.verticalGradient(
                    listOf(
                        Color(0xE6081426),
                        Color(0xF2040914)
                    )
                )
            )
            .border(1.5.dp, borderBrush, RoundedCornerShape(cardRadius))
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            content = content
        )
    }
}

/**
 * Concentric triple-ring success badge with glowing outer halo, translucent ring,
 * solid mint/emerald green circle, and dark checkmark icon.
 */
@Composable
private fun TradeExecutedSuccessBadge() {
    Box(
        modifier = Modifier
            .size(72.dp)
            .drawBehind {
                // Ambient radial glow behind badge
                drawCircle(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color(0x3000FFA3),
                            Color(0x1000FFA3),
                            Color.Transparent
                        ),
                        center = Offset(size.width / 2f, size.height / 2f),
                        radius = size.width * 0.55f
                    )
                )
            },
        contentAlignment = Alignment.Center
    ) {
        // Outer translucent ring with subtle border
        Box(
            modifier = Modifier
                .size(62.dp)
                .clip(CircleShape)
                .background(Color(0x1A00FFA3))
                .border(1.dp, Color(0x4000FFA3), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            // Inner solid emerald green circle
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(Color(0xFF00E676)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Default.Check,
                    contentDescription = "Success",
                    tint = Color(0xFF041A10),
                    modifier = Modifier.size(24.dp)
                )
            }
        }
    }
}

/**
 * Inner card container with dark glassy fill and subtle cyan border.
 */
@Composable
private fun TradeExecutedInnerCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) {
    val shape = RoundedCornerShape(14.dp)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Color(0xFF081220))
            .border(
                1.dp,
                Brush.verticalGradient(
                    listOf(
                        Color(0xFF0084FF).copy(alpha = 0.5f),
                        Color(0xFF0044AA).copy(alpha = 0.25f)
                    )
                ),
                shape
            )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            content = content
        )
    }
}

@Composable
private fun ExecutionDetailRow(
    label: String,
    value: String,
    valueColor: Color = Color.White,
    testTag: String? = null
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 7.dp)
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            color = Color(0xFF94B0D0),
            fontSize = 13.5.sp,
            fontWeight = FontWeight.Normal
        )
        Text(
            text = value,
            color = valueColor,
            fontSize = 13.5.sp,
            fontWeight = FontWeight.Bold,
            style = TextStyle(fontFeatureSettings = "tnum")
        )
    }
}

/**
 * Premium cyber button with radiant cyan-to-purple horizontal gradient.
 */
@Composable
private fun TradeExecutedCtaButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val buttonShape = RoundedCornerShape(24.dp)
    val buttonGradient = Brush.horizontalGradient(
        listOf(
            Color(0xFF0099FF),
            Color(0xFF6B42FF),
            Color(0xFFB526FF)
        )
    )

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(buttonShape)
            .background(buttonGradient)
            .clickable(onClick = onClick)
            .testTag("trade_executed_cta_button"),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = text,
            color = Color.White,
            fontSize = 14.5.sp,
            fontWeight = FontWeight.ExtraBold,
            letterSpacing = 0.5.sp,
            textAlign = TextAlign.Center
        )
    }
}

/**
 * Subtle horizon cyan light beam at the base of the card.
 */
@Composable
private fun TradeExecutedBottomHorizonGlow() {
    Spacer(Modifier.height(16.dp))
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(30.dp)
            .drawBehind {
                drawOval(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color(0x6000B4FF),
                            Color(0x250077FE),
                            Color.Transparent
                        ),
                        center = Offset(size.width / 2f, size.height * 0.5f),
                        radius = size.width * 0.35f
                    )
                )
            }
    )
}
