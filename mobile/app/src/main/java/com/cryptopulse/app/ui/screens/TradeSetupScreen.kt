package com.cryptopulse.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.ui.components.CoinInfoCard
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.strategies.TradeSetupConfigResult
import com.cryptopulse.app.ui.strategies.TradeSetupViewModel
import com.cryptopulse.app.ui.strategies.components.DynamicFieldRenderer
import com.cryptopulse.app.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TradeSetupScreen(
    candidate: MarketCandidate,
    onBack: () -> Unit,
    onProceedToConfirm: () -> Unit,
    viewModel: TradeSetupViewModel
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    val uiState by viewModel.uiState.collectAsState()
    val balanceState by viewModel.balanceState.collectAsState()

    LaunchedEffect(candidate) {
        viewModel.setMinNotional(candidate.minNotional)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgGradient)
            .testTag("trade_setup_root")
    ) {
        Scaffold(
            topBar = { CryptoPulseTopBar(onBack = onBack) },
            containerColor = Color.Transparent,
            bottomBar = {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(NavyDeep)
                        .padding(horizontal = 20.dp, vertical = 12.dp)
                ) {
                    val isSuccess = !uiState.isLoading && uiState.error == null && uiState.entryPriceError == null && uiState.tradeValueUsdtError == null
                    GradientButton(
                        text = if (isSuccess) "Start Analysis" else "Loading...",
                        onClick = {
                            val result = viewModel.buildConfig(candidate.symbol)
                            if (result is TradeSetupConfigResult.Success) {
                                onProceedToConfirm()
                            }
                        },
                        enabled = isSuccess,
                        leadingIcon = Icons.Default.Check,
                        testTag = "trade_setup_proceed_button"
                    )
                }
            }
        ) { padding ->

            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 16.dp),
            ) {
                item {
                    Spacer(Modifier.height(12.dp))

                    Text(
                        text = "TRADE SETUP",
                        color = CyanPrimary,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 22.sp,
                        letterSpacing = 2.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "Configure strategy parameters based on schema.",
                        color = TextSecondary,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )

                    Spacer(Modifier.height(14.dp))
                    CoinInfoCard(candidate = candidate)
                    Spacer(Modifier.height(10.dp))
                    AvailableBalanceCard(
                        balanceState = balanceState,
                        onRetry = { viewModel.loadBalance() }
                    )
                    if (candidate.minNotional > 0.0) {
                        Spacer(Modifier.height(8.dp))
                        Surface(
                            shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
                            color = Color(0xFF131D30),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = "Minimum Tradable Price:",
                                    color = TextSecondary,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Normal
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    text = "$${"%.2f".format(candidate.minNotional)} USDT",
                                    color = CyanPrimary,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                }

                if (uiState.isLoading) {
                    item {
                        Box(modifier = Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = CyanPrimary)
                        }
                    }
                } else if (uiState.error != null) {
                    item {
                        Text(
                            text = "Error: ${uiState.error}",
                            color = LossRed,
                            modifier = Modifier.fillMaxWidth().padding(16.dp),
                            textAlign = TextAlign.Center
                        )
                    }
                } else {
                    item {
                        OutlinedTextField(
                            value = uiState.entryPrice,
                            onValueChange = { newValue ->
                                if (newValue.isEmpty() || newValue.matches(Regex("^\\d*\\.?\\d*$"))) {
                                    viewModel.updateEntryPrice(newValue)
                                }
                            },
                            label = { Text("Target Entry Price (USDT)") },
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("trade_setup_entry_price"),
                            isError = uiState.entryPriceError != null,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = TextPrimary,
                                unfocusedTextColor = TextPrimary,
                                cursorColor = CyanPrimary,
                                focusedBorderColor = CyanPrimary,
                                unfocusedBorderColor = Color(0xFF2A3650),
                                errorBorderColor = LossRed
                            ),
                            supportingText = {
                                val entryPriceError = uiState.entryPriceError
                                if (entryPriceError != null) {
                                    Text(
                                        text = entryPriceError,
                                        color = LossRed,
                                        fontSize = 12.sp
                                    )
                                } else if (candidate.currentMarketPrice > 0.0) {
                                    Text(
                                        text = "Current price: $${"%.2f".format(candidate.currentMarketPrice)}" +
                                                if (uiState.minNotional > 0.0) " | Min Notional: $${"%.2f".format(uiState.minNotional)} USDT" else "",
                                        color = TextSecondary,
                                        fontSize = 12.sp
                                    )
                                }
                            }
                        )
                    }

                    item {
                        OutlinedTextField(
                            value = uiState.tradeValueUsdt,
                            onValueChange = { newValue ->
                                if (newValue.isEmpty() || newValue.matches(Regex("^\\d*\\.?\\d*$"))) {
                                    viewModel.updateTradeValueUsdt(newValue)
                                }
                            },
                            label = { Text("Trade Amount (USDT)") },
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("trade_setup_trade_value"),
                            isError = uiState.tradeValueUsdtError != null,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = TextPrimary,
                                unfocusedTextColor = TextPrimary,
                                cursorColor = CyanPrimary,
                                focusedBorderColor = CyanPrimary,
                                unfocusedBorderColor = Color(0xFF2A3650),
                                errorBorderColor = LossRed
                            ),
                            supportingText = {
                                val tradeValueUsdtError = uiState.tradeValueUsdtError
                                if (tradeValueUsdtError != null) {
                                    Text(
                                        text = tradeValueUsdtError,
                                        color = LossRed,
                                        fontSize = 12.sp
                                    )
                                } else if (uiState.minNotional > 0.0) {
                                    Text(
                                        text = "Minimum notional: $${"%.2f".format(uiState.minNotional)} USDT",
                                        color = TextSecondary,
                                        fontSize = 12.sp
                                    )
                                }
                            }
                        )
                    }

                    items(items = uiState.fields, key = { it.key }) { field ->
                        val currentValue = uiState.formValues[field.key] ?: ""
                        val error = uiState.formErrors[field.key]
                        DynamicFieldRenderer(
                            field = field,
                            currentValue = currentValue,
                            error = error,
                            onValueChange = { newValue ->
                                viewModel.updateFieldValue(field.key, newValue)
                            }
                        )
                    }
                    item {
                        Spacer(Modifier.height(80.dp))
                    }
                }
            }
        }
    }
}

@Composable
fun AvailableBalanceCard(
    balanceState: com.cryptopulse.app.ui.strategies.BalanceUiState,
    onRetry: () -> Unit
) {
    Surface(
        shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
        color = Color(0xFF0F1B2D),
        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFF1E2D4A)),
        modifier = Modifier
            .fillMaxWidth()
            .testTag("available_balance_card")
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Available Balance",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium
                )
                when (balanceState) {
                    is com.cryptopulse.app.ui.strategies.BalanceUiState.Success -> {
                        Text(
                            text = "${balanceState.exchangeName} • ${balanceState.environment}",
                            color = TextSecondary,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Normal
                        )
                    }
                    else -> {}
                }
            }

            Spacer(Modifier.height(4.dp))

            when (balanceState) {
                is com.cryptopulse.app.ui.strategies.BalanceUiState.Loading -> {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            color = CyanPrimary,
                            strokeWidth = 2.dp
                        )
                        Text(
                            text = "Fetching wallet balance...",
                            color = TextSecondary,
                            fontSize = 13.sp
                        )
                    }
                }
                is com.cryptopulse.app.ui.strategies.BalanceUiState.Success -> {
                    val formatted = String.format("%,.2f", balanceState.freeBalance)
                    Text(
                        text = "$formatted ${balanceState.primaryAsset}",
                        color = ProfitGreen,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 0.5.sp
                    )
                }
                is com.cryptopulse.app.ui.strategies.BalanceUiState.NotConnected -> {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "No exchange connected",
                            color = Color(0xFFFFB74D),
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium
                        )
                        TextButton(onClick = onRetry) {
                            Text("Retry", color = CyanPrimary, fontSize = 12.sp)
                        }
                    }
                }
                is com.cryptopulse.app.ui.strategies.BalanceUiState.Error -> {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = balanceState.message,
                            color = Color(0xFFFF5252),
                            fontSize = 12.sp,
                            modifier = Modifier.weight(1f)
                        )
                        TextButton(onClick = onRetry) {
                            Text("Retry", color = CyanPrimary, fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}
