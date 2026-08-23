package com.cryptopulse.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.TrendingDown
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.domain.models.TradeExecutionResult
import com.cryptopulse.app.ui.theme.*
import java.text.NumberFormat
import java.util.Locale

@Composable
fun TradeExecutionConfirmationCard(
    result: TradeExecutionResult,
    onViewInPortfolio: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier
) {
    val priceFormatter = remember {
        NumberFormat.getNumberInstance(Locale.US).apply {
            minimumFractionDigits = 2
            maximumFractionDigits = 6
        }
    }

    val isBuy = result.side.equals("BUY", ignoreCase = true)
    val sideColor = if (isBuy) ProfitGreen else LossRed

    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(
            containerColor = NavyCard
        ),
        border = CardDefaults.outlinedCardBorder().copy(
            brush = Brush.verticalGradient(
                listOf(ProfitGreen.copy(alpha = 0.8f), CyanPrimary.copy(alpha = 0.3f))
            )
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 8.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Header: Success Icon & Title
            Box(
                modifier = Modifier
                    .size(56.dp)
                    .background(ProfitGreen.copy(alpha = 0.15f), RoundedCornerShape(28.dp))
                    .border(1.5.dp, ProfitGreen.copy(alpha = 0.5f), RoundedCornerShape(28.dp)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = "Trade Executed",
                    tint = ProfitGreen,
                    modifier = Modifier.size(32.dp)
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            Text(
                text = "Trade Executed at ${result.exchange.replaceFirstChar { it.uppercase() }}",
                color = Color.White,
                fontSize = 18.sp,
                fontWeight = FontWeight.ExtraBold,
                textAlign = TextAlign.Center
            )

            Text(
                text = "Order matched and filled on ${result.exchange.replaceFirstChar { it.uppercase() }} (${result.environment.replaceFirstChar { it.uppercase() }})",
                color = TextSecondary,
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 2.dp)
            )

            Spacer(modifier = Modifier.height(16.dp))

            // Pair & Side Badge
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(NavyDeep, RoundedCornerShape(12.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = result.symbol,
                        color = Color.White,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold
                    )
                    if (result.strategy.isNotEmpty()) {
                        Text(
                            text = "Strategy: ${result.strategy}",
                            color = TextSecondary,
                            fontSize = 11.sp
                        )
                    }
                }

                Row(
                    modifier = Modifier
                        .background(sideColor.copy(alpha = 0.18f), RoundedCornerShape(8.dp))
                        .border(1.dp, sideColor.copy(alpha = 0.5f), RoundedCornerShape(8.dp))
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        imageVector = if (isBuy) Icons.Default.TrendingUp else Icons.Default.TrendingDown,
                        contentDescription = null,
                        tint = sideColor,
                        modifier = Modifier.size(14.dp)
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        text = result.side.uppercase(),
                        color = sideColor,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            Spacer(modifier = Modifier.height(14.dp))

            // Pricing Comparison Box: Requested vs Actual Fill
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF0A1528), RoundedCornerShape(14.dp))
                    .border(1.dp, CyanPrimary.copy(alpha = 0.25f), RoundedCornerShape(14.dp))
                    .padding(14.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("Requested Entry", color = TextSecondary, fontSize = 12.sp)
                    Text(
                        text = "$${priceFormatter.format(result.requestedEntryPrice)}",
                        color = TextSecondary,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Actual Fill Price", color = CyanPrimary, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    }
                    Text(
                        text = "$${priceFormatter.format(result.actualFillPrice)}",
                        color = CyanPrimary,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.ExtraBold
                    )
                }

                if (result.slippagePercent > 0.0) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text("Slippage", color = TextSecondary, fontSize = 11.sp)
                        Text(
                            text = "${String.format(Locale.US, "%.3f", result.slippagePercent)}%",
                            color = if (result.slippagePercent < 0.1) ProfitGreen else WarningOrange,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Execution Details Grid
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(NavyDeep.copy(alpha = 0.6f), RoundedCornerShape(12.dp))
                    .padding(12.dp)
            ) {
                DetailRow(
                    label = "Filled Quantity",
                    value = "${priceFormatter.format(result.actualFilledQuantity)} (${if (result.isFilled) "100% Filled" else result.entryStatus})"
                )
                if (result.stopLoss > 0.0) {
                    DetailRow(label = "Stop Loss", value = "$${priceFormatter.format(result.stopLoss)}")
                }
                if (result.takeProfit > 0.0) {
                    DetailRow(label = "Take Profit", value = "$${priceFormatter.format(result.takeProfit)}")
                }
                if (result.orderId.isNotEmpty()) {
                    DetailRow(
                        label = "Exchange Order ID",
                        value = result.orderId.takeLast(16)
                    )
                }
            }

            Spacer(modifier = Modifier.height(20.dp))

            // Action Buttons
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                OutlinedButton(
                    onClick = onDismiss,
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                    border = ButtonDefaults.outlinedButtonBorder.copy(
                        brush = Brush.horizontalGradient(listOf(TextSecondary, TextSecondary))
                    )
                ) {
                    Text("Close", fontWeight = FontWeight.SemiBold)
                }

                GradientButton(
                    text = "View Portfolio",
                    onClick = onViewInPortfolio,
                    modifier = Modifier.weight(1.4f)
                )
            }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text = label, color = TextSecondary, fontSize = 12.sp)
        Text(text = value, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}
