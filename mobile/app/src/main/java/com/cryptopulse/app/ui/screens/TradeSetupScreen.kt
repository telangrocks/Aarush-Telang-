package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.compose.foundation.background
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import kotlinx.coroutines.launch
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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
    balance: Double?,
    balancesError: String?,
    asset: String,
    exchangeName: String,
    environmentName: String,
    onBack: () -> Unit,
    onProceedToAnalysis: () -> Unit,
    viewModel: TradeSetupViewModel
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    val uiState by viewModel.uiState.collectAsState()
    val scope = rememberCoroutineScope()
    
    LaunchedEffect(candidate) {
        viewModel.setConstraints(candidate, exchangeName)
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
                    val isButtonEnabled = !uiState.isLoading && uiState.error == null
                    GradientButton(
                        text = if (uiState.isLoading) "Loading..." else "CONFIRM",
                        onClick = {
                            scope.launch {
                                val strategyId = java.util.UUID.randomUUID().toString()
                                val result = viewModel.validateAndConfirmTrade(strategyId, candidate, exchangeName, balance)
                                if (result is TradeSetupConfigResult.Success) {
                                    onProceedToAnalysis()
                                }
                            }
                        },
                        enabled = isButtonEnabled,
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
                        text = "Configure parameters for execution.",
                        color = TextSecondary,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )

                    Spacer(Modifier.height(14.dp))
                    CoinInfoCard(candidate = candidate)
                    Spacer(Modifier.height(10.dp))
                    AvailableBalanceCard(
                        balance = balance,
                        balancesError = balancesError,
                        asset = asset,
                        exchangeName = exchangeName,
                        environmentName = environmentName
                    )
                    
                    Spacer(Modifier.height(8.dp))
                    val minQtyText = candidate.minOrderQty?.let { it.toString() } ?: "N/A"
                    Text(
                        text = "Minimum Order Quantity: $minQtyText",
                        color = CyanPrimary,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )
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
                                    viewModel.updateEntryPrice(newValue, candidate, exchangeName)
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
                                        text = "Current price: $${"%.2f".format(candidate.currentMarketPrice)}",
                                        color = TextSecondary,
                                        fontSize = 12.sp
                                    )
                                }
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
    balance: Double?,
    balancesError: String?,
    asset: String,
    exchangeName: String,
    environmentName: String
) {
    val accessibleBalanceText = if (balancesError != null) {
        "Error: $balancesError"
    } else if (balance != null) {
        "Available balance ${String.format(java.util.Locale.US, "%,.2f", balance)} $asset on $exchangeName $environmentName."
    } else {
        "Fetching wallet balance."
    }

    Surface(
        shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
        color = Color(0xFF0F1B2D),
        border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFF1E2D4A)),
        modifier = Modifier
            .fillMaxWidth()
            .testTag("available_balance_card")
            .semantics(mergeDescendants = true) {
                contentDescription = accessibleBalanceText
            }
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
                Text(
                    text = "$exchangeName • $environmentName",
                    color = TextSecondary,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Normal
                )
            }

            Spacer(Modifier.height(4.dp))

            if (balancesError != null) {
                Text(
                    text = "Error: $balancesError",
                    color = LossRed,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.5.sp
                )
            } else if (balance != null) {
                val formatted = String.format("%,.2f", balance)
                Text(
                    text = "$formatted $asset",
                    color = ProfitGreen,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.5.sp
                )
            } else {
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
        }
    }
}
