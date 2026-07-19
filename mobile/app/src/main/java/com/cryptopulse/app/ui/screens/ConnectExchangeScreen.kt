package com.cryptopulse.app.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Store
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavController
import com.cryptopulse.app.ui.auth.ExchangeUiState
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.auth.AuthFieldLabel
import com.cryptopulse.app.ui.auth.DarkTextField
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectExchangeScreen(
    navController: NavController,
    viewModel: ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
    exchangeConnectionManager: com.cryptopulse.app.data.local.ExchangeConnectionManager = com.cryptopulse.app.data.local.ExchangeConnectionManager(LocalContext.current.applicationContext),
) {
    val formState by viewModel.formState.collectAsState()
    val uiState by viewModel.uiState.collectAsState()
    val candidates by viewModel.candidates.collectAsState()
    val readyForCandidates by viewModel.readyForCandidates.collectAsState()

    LaunchedEffect(readyForCandidates, candidates) {
        if (readyForCandidates && candidates.isNotEmpty()) {
            navController.navigate("market_candidates") {
                popUpTo("welcome") { inclusive = true }
            }
        }
    }

    LaunchedEffect(Unit) {
        val (isConnected, _, _) = exchangeConnectionManager.getConnectionInfo()
        if (isConnected) {
            navController.navigate("market_candidates") {
                popUpTo("welcome") { inclusive = true }
            }
        }
    }

    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    Scaffold(
        topBar = { CryptoPulseTopBar(onBack = { navController.popBackStack() }) },
        containerColor = Color.Transparent,
        snackbarHost = {
            if (uiState is ExchangeUiState.Error) {
                val errorState = uiState as ExchangeUiState.Error
                Snackbar(
                    modifier = Modifier.padding(16.dp),
                    containerColor = Color(0xFF1A0A10),
                    contentColor = LossRed,
                    action = {
                        TextButton(onClick = { viewModel.resetState() }) {
                            Text("Dismiss", color = LossRed)
                        }
                    },
                ) {
                    Column {
                        Text(errorState.message)
                        if (!errorState.hint.isNullOrBlank()) {
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = errorState.hint!!,
                                color = LossRed.copy(alpha = 0.8f),
                                fontSize = 12.sp,
                            )
                        }
                    }
                }
            }
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(bgGradient)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 8.dp)
                    .testTag("connect_exchange_root"),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(8.dp))

                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        imageVector = Icons.Default.Store,
                        contentDescription = null,
                        tint = CyanPrimary,
                        modifier = Modifier.size(26.dp),
                    )
                    Spacer(Modifier.width(10.dp))
                    Text(
                        text = "CONNECT EXCHANGE",
                        color = CyanPrimary,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 22.sp,
                        letterSpacing = 1.5.sp,
                    )
                }

                Spacer(Modifier.height(8.dp))

                Text(
                    text = "Select your exchange and enter your API credentials to start trading.",
                    color = TextSecondary,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    lineHeight = 20.sp,
                )

                Spacer(Modifier.height(24.dp))

                GlowCard {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Default.Store,
                                contentDescription = null,
                                tint = CyanPrimary,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = "SELECT EXCHANGE",
                                color = CyanPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                letterSpacing = 1.2.sp,
                            )
                        }

                        Spacer(Modifier.height(16.dp))

                        ExchangeDropdown(
                            selectedExchange = formState.selectedExchange,
                            onExchangeSelected = viewModel::onExchangeSelected,
                        )

                        Spacer(Modifier.height(20.dp))

                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Default.Cloud,
                                contentDescription = null,
                                tint = CyanPrimary,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = "ENVIRONMENT",
                                color = CyanPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                letterSpacing = 1.2.sp,
                            )
                        }

                        Spacer(Modifier.height(12.dp))

                        EnvironmentToggle(
                            selectedEnvironment = formState.environment,
                            onEnvironmentSelected = viewModel::onEnvironmentSelected,
                        )

                        Spacer(Modifier.height(8.dp))

                        Text(
                            text = if (formState.environment == "testnet") {
                                "Testnet uses the exchange's sandbox endpoints and demo funds. Use your Testnet API keys."
                            } else {
                                "Mainnet uses the real exchange with live funds. Use your production API keys."
                            },
                            color = TextSecondary,
                            fontSize = 11.sp,
                            lineHeight = 16.sp,
                        )

                        Spacer(Modifier.height(20.dp))

                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Default.Key,
                                contentDescription = null,
                                tint = CyanPrimary,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = "API CREDENTIALS",
                                color = CyanPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                letterSpacing = 1.2.sp,
                            )
                        }

                        Spacer(Modifier.height(16.dp))

                        AuthFieldLabel("API KEY")
                        Spacer(Modifier.height(4.dp))
                        DarkTextField(
                            value = formState.apiKey,
                            onValueChange = viewModel::onApiKeyChanged,
                            placeholder = "Enter your API Key",
                            isError = formState.apiKeyError != null,
                            testTag = "api_key_input",
                            trailingIcon = {
                                Icon(Icons.Default.Key, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                            },
                        )
                        if (formState.apiKeyError != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = formState.apiKeyError!!,
                                color = LossRed,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(start = 4.dp),
                            )
                        }

                        Spacer(Modifier.height(14.dp))

                        AuthFieldLabel("API SECRET")
                        Spacer(Modifier.height(4.dp))
                        DarkTextField(
                            value = formState.apiSecret,
                            onValueChange = viewModel::onApiSecretChanged,
                            placeholder = "Enter your API Secret",
                            visualTransformation = PasswordVisualTransformation(),
                            isError = formState.apiSecretError != null,
                            testTag = "api_secret_input",
                            trailingIcon = {
                                Icon(Icons.Default.Lock, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                            },
                        )
                        if (formState.apiSecretError != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = formState.apiSecretError!!,
                                color = LossRed,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(start = 4.dp),
                            )
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0x1400B4FF), RoundedCornerShape(10.dp))
                        .border(1.dp, CyanPrimary.copy(alpha = 0.2f), RoundedCornerShape(10.dp))
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.Info, null, tint = CyanPrimary, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "Your API keys are encrypted and never stored in plain text. We only use them to validate and fetch market data.",
                        color = TextSecondary,
                        fontSize = 11.sp,
                        lineHeight = 17.sp,
                    )
                }

                Spacer(Modifier.height(16.dp))

                GradientButton(
                    text = when {
                        uiState is ExchangeUiState.Validating || uiState is ExchangeUiState.Connecting -> "Processing…"
                        formState.validationMessage != null -> "Retry"
                        else -> "Validate & Connect"
                    },
                    onClick = { viewModel.validateAndConnect() },
                    enabled = formState.apiKey.isNotBlank() && formState.apiSecret.isNotBlank(),
                    leadingIcon = when (uiState) {
                        is ExchangeUiState.Connected -> Icons.Default.CheckCircle
                        is ExchangeUiState.Error -> Icons.Default.Error
                        else -> Icons.Default.ArrowForward
                    },
                    testTag = "exchange_connect_button",
                )

                Spacer(Modifier.height(20.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ExchangeDropdown(
    selectedExchange: String,
    onExchangeSelected: (String) -> Unit,
) {
    val exchanges = listOf(
        "binance" to "Binance",
        "delta" to "Delta Exchange India",
        "bybit" to "Bybit",
    )
    var expanded by remember { mutableStateOf(false) }

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = !expanded },
    ) {
                            OutlinedTextField(
                                value = exchanges.find { it.first == selectedExchange }?.second ?: selectedExchange,
                                onValueChange = {},
                                readOnly = true,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .menuAnchor()
                                    .testTag("exchange_dropdown"),
                                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = CyanPrimary,
                unfocusedBorderColor = NavyBorder,
                cursorColor = CyanPrimary,
                focusedTextColor = TextPrimary,
                unfocusedTextColor = TextPrimary,
                focusedContainerColor = NavyCard,
                unfocusedContainerColor = NavyCard,
            ),
            shape = RoundedCornerShape(10.dp),
        )
        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier.background(NavyCard),
        ) {
            exchanges.forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(text = label, color = TextPrimary) },
                    onClick = {
                        onExchangeSelected(value)
                        expanded = false
                    },
                )
            }
        }
    }
}

@Composable
private fun EnvironmentToggle(
    selectedEnvironment: String,
    onEnvironmentSelected: (String) -> Unit,
) {
    val options = listOf(
        "testnet" to "Testnet",
        "mainnet" to "Mainnet",
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(NavyCard, RoundedCornerShape(10.dp))
            .border(1.dp, NavyBorder, RoundedCornerShape(10.dp))
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        options.forEach { (value, label) ->
            val selected = selectedEnvironment == value
            Box(
                modifier = Modifier
                    .weight(1f)
                    .background(
                        if (selected) CyanPrimary.copy(alpha = 0.18f) else Color.Transparent,
                        RoundedCornerShape(8.dp),
                    )
                    .border(
                        1.dp,
                        if (selected) CyanPrimary else Color.Transparent,
                        RoundedCornerShape(8.dp),
                    )
                    .clickable { onEnvironmentSelected(value) }
                    .padding(vertical = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = label,
                    color = if (selected) CyanPrimary else TextSecondary,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                    fontSize = 13.sp,
                    letterSpacing = 0.8.sp,
                )
            }
        }
    }
}


