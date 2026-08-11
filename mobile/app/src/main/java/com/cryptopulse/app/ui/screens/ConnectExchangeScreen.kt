package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Store
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
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

import android.util.Log

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectExchangeScreen(
    navController: NavController,
    viewModel: ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
    exchangeConnectionManager: com.cryptopulse.app.data.local.ExchangeConnectionManager = com.cryptopulse.app.data.local.ExchangeConnectionManager(LocalContext.current.applicationContext),
) {
    Log.d("VM_CHECK", "[DIAGNOSTIC] ConnectExchangeScreen ExchangeViewModel hash=${System.identityHashCode(viewModel)}")
    Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] Screen ViewModel: ${System.identityHashCode(viewModel)}")

    val formState by viewModel.formState.collectAsState()
    val uiState by viewModel.uiState.collectAsState()
    val candidates by viewModel.candidates.collectAsState()
    val readyForCandidates by viewModel.readyForCandidates.collectAsState()
    var apiSecretVisible by remember { mutableStateOf(false) }

    Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] Observed: uiState=$uiState ready=$readyForCandidates candidates=${candidates.size}")

    LaunchedEffect(uiState, readyForCandidates, candidates) {
        Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] LaunchedEffect triggered: uiState=$uiState, readyForCandidates=$readyForCandidates, candidatesCount=${candidates.size}")
        if (uiState is ExchangeUiState.Connected || readyForCandidates) {
            Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] NAVIGATING -> market_candidates")
            navController.navigate("market_candidates") {
                popUpTo("connect_exchange") { inclusive = true }
            }
        }
    }

    LaunchedEffect(Unit) {
        val (isConnected, _, _) = exchangeConnectionManager.getConnectionInfo()
        Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] Initial connection check: isConnected=$isConnected")
        if (isConnected) {
            Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] navigation call (existing connection): navController.navigate('market_candidates')")
            navController.navigate("market_candidates") {
                popUpTo("connect_exchange") { inclusive = true }
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
                    .padding(horizontal = 24.dp, vertical = 12.dp)
                    .testTag("connect_exchange_root"),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(4.dp))

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    Icon(
                        imageVector = Icons.Default.Store,
                        contentDescription = null,
                        tint = CyanPrimary,
                        modifier = Modifier.size(24.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "CONNECT EXCHANGE",
                        color = CyanPrimary,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 20.sp,
                        letterSpacing = 1.5.sp,
                    )
                }

                Spacer(Modifier.height(4.dp))

                Text(
                    text = "Select your exchange and enter API credentials",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                )

                Spacer(Modifier.height(16.dp))

                GlowCard {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp)
                    ) {
                        AuthFieldLabel("EXCHANGE")
                        Spacer(Modifier.height(4.dp))
                        ExchangeDropdown(
                            selectedExchange = formState.selectedExchange,
                            onExchangeSelected = viewModel::onExchangeSelected,
                        )

                        Spacer(Modifier.height(12.dp))

                        AuthFieldLabel("ENVIRONMENT")
                        Spacer(Modifier.height(4.dp))
                        EnvironmentToggle(
                            selectedExchange = formState.selectedExchange,
                            selectedEnvironment = formState.environment,
                            onEnvironmentSelected = viewModel::onEnvironmentSelected,
                        )

                        Spacer(Modifier.height(12.dp))

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
                            Spacer(Modifier.height(2.dp))
                            Text(
                                text = formState.apiKeyError!!,
                                color = LossRed,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(start = 4.dp),
                            )
                        }

                        Spacer(Modifier.height(12.dp))

                        AuthFieldLabel("API SECRET")
                        Spacer(Modifier.height(4.dp))
                        DarkTextField(
                            value = formState.apiSecret,
                            onValueChange = viewModel::onApiSecretChanged,
                            placeholder = "Enter your API Secret",
                            visualTransformation = if (apiSecretVisible) VisualTransformation.None else PasswordVisualTransformation(),
                            isError = formState.apiSecretError != null,
                            testTag = "api_secret_input",
                            trailingIcon = {
                                IconButton(onClick = { apiSecretVisible = !apiSecretVisible }) {
                                    Icon(
                                        imageVector = if (apiSecretVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                        contentDescription = if (apiSecretVisible) "Hide API Secret" else "Show API Secret",
                                        tint = TextSecondary,
                                        modifier = Modifier.size(18.dp)
                                    )
                                }
                            },
                        )
                        if (formState.apiSecretError != null) {
                            Spacer(Modifier.height(2.dp))
                            Text(
                                text = formState.apiSecretError!!,
                                color = LossRed,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(start = 4.dp),
                            )
                        }

                        if (formState.selectedExchange.equals("kucoin", ignoreCase = true)) {
                            Spacer(Modifier.height(12.dp))

                            AuthFieldLabel("API PASSPHRASE")
                            Spacer(Modifier.height(4.dp))
                            var apiPassphraseVisible by remember { mutableStateOf(false) }
                            DarkTextField(
                                value = formState.apiPassphrase,
                                onValueChange = viewModel::onApiPassphraseChanged,
                                placeholder = "Enter your API Passphrase",
                                visualTransformation = if (apiPassphraseVisible) VisualTransformation.None else PasswordVisualTransformation(),
                                isError = formState.apiPassphraseError != null,
                                testTag = "api_passphrase_input",
                                trailingIcon = {
                                    IconButton(onClick = { apiPassphraseVisible = !apiPassphraseVisible }) {
                                        Icon(
                                            imageVector = if (apiPassphraseVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                            contentDescription = if (apiPassphraseVisible) "Hide API Passphrase" else "Show API Passphrase",
                                            tint = TextSecondary,
                                            modifier = Modifier.size(18.dp)
                                        )
                                    }
                                },
                            )
                            if (formState.apiPassphraseError != null) {
                                Spacer(Modifier.height(2.dp))
                                Text(
                                    text = formState.apiPassphraseError!!,
                                    color = LossRed,
                                    fontSize = 11.sp,
                                    modifier = Modifier.padding(start = 4.dp),
                                )
                            }
                        }
                    }
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

                Spacer(Modifier.height(12.dp))
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
        "bybit" to "Bybit",
        "kucoin" to "KuCoin",
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
    selectedExchange: String,
    selectedEnvironment: String,
    onEnvironmentSelected: (String) -> Unit,
) {
    val options = if (selectedExchange.equals("bybit", ignoreCase = true)) {
        listOf(
            "testnet" to "Testnet",
            "demo" to "Demo",
            "mainnet" to "Mainnet",
        )
    } else {
        listOf(
            "testnet" to "Testnet",
            "mainnet" to "Mainnet",
        )
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(NavyCard, RoundedCornerShape(10.dp))
            .border(1.dp, NavyBorder, RoundedCornerShape(10.dp))
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        options.forEach { (value, label) ->
            val selected = selectedEnvironment.equals(value, ignoreCase = true)
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

