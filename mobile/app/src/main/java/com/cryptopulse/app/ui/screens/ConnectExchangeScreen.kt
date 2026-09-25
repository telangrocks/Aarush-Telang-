package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import android.util.Log
import androidx.activity.ComponentActivity
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Store
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavController
import com.cryptopulse.app.R
import com.cryptopulse.app.ui.auth.ExchangeUiState
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.components.LocalOnLogout
import com.cryptopulse.app.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectExchangeScreen(
    navController: NavController,
    viewModel: ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
    exchangeConnectionManager: com.cryptopulse.app.data.local.ExchangeConnectionManager = com.cryptopulse.app.data.local.ExchangeConnectionManager(LocalContext.current.applicationContext),
    isChangingApiKeys: Boolean = false,
) {
    Log.d("VM_CHECK", "[DIAGNOSTIC] ConnectExchangeScreen ExchangeViewModel hash=${System.identityHashCode(viewModel)}")
    Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] Screen ViewModel: ${System.identityHashCode(viewModel)}")

    val formState by viewModel.formState.collectAsState()
    val uiState by viewModel.uiState.collectAsState()
    val candidates by viewModel.candidates.collectAsState()
    val readyForCandidates by viewModel.readyForCandidates.collectAsState()
    var apiKeyVisible by remember { mutableStateOf(false) }
    var apiSecretVisible by remember { mutableStateOf(false) }
    var hasSubmittedNewConnection by rememberSaveable { mutableStateOf(false) }

    Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] Observed: uiState=$uiState ready=$readyForCandidates candidates=${candidates.size} isChangingApiKeys=$isChangingApiKeys hasSubmittedNewConnection=$hasSubmittedNewConnection")

    // When opened from "Change API Keys", suppress the auto-redirect so the user
    // can actually see and interact with the form. Once they explicitly tap VALIDATE & CONNECT
    // and successfully re-connect (uiState becomes Connected / readyForCandidates flips to true)
    // we navigate forward to market_candidates.
    LaunchedEffect(uiState, readyForCandidates, candidates, hasSubmittedNewConnection) {
        Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] LaunchedEffect triggered: uiState=$uiState, readyForCandidates=$readyForCandidates, candidatesCount=${candidates.size}, isChangingApiKeys=$isChangingApiKeys, hasSubmittedNewConnection=$hasSubmittedNewConnection")
        val shouldNavigate = if (isChangingApiKeys) {
            hasSubmittedNewConnection && (uiState is ExchangeUiState.Connected || readyForCandidates)
        } else {
            uiState is ExchangeUiState.Connected || readyForCandidates
        }
        if (shouldNavigate) {
            Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] NAVIGATING -> trade_setup")
            val popRoute = if (isChangingApiKeys) "change_api_keys" else "connect_exchange"
            navController.navigate("trade_setup") {
                popUpTo(popRoute) { inclusive = true }
            }
        }
    }

    // Skip the "already connected → redirect immediately" check when the user
    // opened this screen intentionally to change their API keys.
    // Preserves existing connection, credentials, and candidates completely safe.
    LaunchedEffect(Unit) {
        if (isChangingApiKeys) {
            // Stay on Connect Exchange screen; do not redirect and do NOT call viewModel.resetState().
            return@LaunchedEffect
        }
        val (isConnected, _, _) = exchangeConnectionManager.getConnectionInfo()
        Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] Initial connection check: isConnected=$isConnected")
        if (isConnected) {
            Log.d("ConnectExchangeScreen", "[DIAGNOSTIC] navigation call (existing connection): navController.navigate('trade_setup')")
            navController.navigate("trade_setup") {
                popUpTo("connect_exchange") { inclusive = true }
            }
        } else {
            viewModel.checkExistingConnection()
        }
    }

    val bgGradient = Brush.verticalGradient(
        0.0f to Color(0xFF000916),
        0.35f to Color(0xFF000B1B),
        0.65f to Color(0xFF000D1E),
        1.0f to Color(0xFF000814)
    )

    Scaffold(
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
                .padding(padding)
        ) {
            // Ambient Bottom Horizon Flare
            ConnectExchangeBottomHorizonGlow(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(140.dp)
                    .align(Alignment.BottomCenter)
            )

            if (uiState is ExchangeUiState.CheckingConnection) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        CircularProgressIndicator(
                            color = Color(0xFF00B4FF),
                            modifier = Modifier.size(38.dp),
                            strokeWidth = 2.5.dp
                        )
                        Spacer(Modifier.height(16.dp))
                        Text(
                            text = "Checking exchange connection...",
                            color = Color(0xFF94B0D0),
                            fontSize = 14.sp
                        )
                    }
                }
            } else {
                val onLogout = LocalOnLogout.current

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .statusBarsPadding()
                        .navigationBarsPadding()
                        .imePadding()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 24.dp)
                        .testTag("connect_exchange_root"),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Spacer(Modifier.height(8.dp))

                    // 1. Top Header Bar: Back Arrow, Brand Lockup, Logout Icon
                    ConnectExchangeTopBar(
                        onBack = { navController.popBackStack() },
                        onLogout = { onLogout?.invoke() ?: navController.popBackStack() }
                    )

                    Spacer(Modifier.height(24.dp))

                    // 2. Heading & Subtitle
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Default.Store,
                            contentDescription = null,
                            tint = Color(0xFF00B4FF),
                            modifier = Modifier.size(26.dp),
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            text = "CONNECT EXCHANGE",
                            color = Color(0xFF00B4FF),
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 24.sp,
                            letterSpacing = 1.8.sp,
                            textAlign = TextAlign.Center
                        )
                    }

                    Spacer(Modifier.height(20.dp))

                    // 3. Glowing Glassmorphic Input Card Container
                    ConnectExchangeCardContainer(
                        modifier = Modifier
                            .fillMaxWidth()
                            .widthIn(max = 480.dp)
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 18.dp, vertical = 22.dp)
                        ) {
                            // EXCHANGE Section
                            ConnectExchangeFieldLabel("EXCHANGE")
                            Spacer(Modifier.height(8.dp))
                            ConnectExchangeRow()

                            Spacer(Modifier.height(18.dp))

                            // ENVIRONMENT Section
                            ConnectExchangeFieldLabel("ENVIRONMENT")
                            Spacer(Modifier.height(8.dp))
                            ConnectExchangeEnvironmentToggle(
                                selectedEnvironment = formState.environment,
                                onEnvironmentSelected = viewModel::onEnvironmentSelected,
                            )

                            Spacer(Modifier.height(18.dp))

                            // API KEY Section
                            ConnectExchangeFieldLabel("API KEY")
                            Spacer(Modifier.height(8.dp))
                            ConnectExchangeInputField(
                                value = formState.apiKey,
                                onValueChange = viewModel::onApiKeyChanged,
                                placeholder = "Enter your API Key",
                                visualTransformation = if (apiKeyVisible) VisualTransformation.None else PasswordVisualTransformation(),
                                isError = formState.apiKeyError != null,
                                testTag = "api_key_input",
                                trailingIcon = {
                                    IconButton(onClick = { apiKeyVisible = !apiKeyVisible }) {
                                        Icon(
                                            imageVector = if (apiKeyVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                            contentDescription = if (apiKeyVisible) "Hide API Key" else "Show API Key",
                                            tint = Color(0xFF5B7B9E),
                                            modifier = Modifier.size(20.dp)
                                        )
                                    }
                                },
                            )
                            if (formState.apiKeyError != null) {
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    text = formState.apiKeyError!!,
                                    color = LossRed,
                                    fontSize = 11.sp,
                                    modifier = Modifier.padding(start = 6.dp),
                                )
                            }

                            Spacer(Modifier.height(18.dp))

                            // API SECRET Section
                            ConnectExchangeFieldLabel("API SECRET")
                            Spacer(Modifier.height(8.dp))
                            ConnectExchangeInputField(
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
                                            tint = Color(0xFF5B7B9E),
                                            modifier = Modifier.size(20.dp)
                                        )
                                    }
                                },
                            )
                            if (formState.apiSecretError != null) {
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    text = formState.apiSecretError!!,
                                    color = LossRed,
                                    fontSize = 11.sp,
                                    modifier = Modifier.padding(start = 6.dp),
                                )
                            }
                        }
                    }

                    Spacer(Modifier.height(24.dp))

                    // 4. Action Button: "VALIDATE & CONNECT"
                    val isConnecting = uiState is ExchangeUiState.Connecting
                    val isFormFilled = formState.apiKey.isNotBlank() && formState.apiSecret.isNotBlank()
                    val buttonText = when {
                        isConnecting -> "PROCESSING…"
                        formState.validationMessage != null -> "RETRY"
                        else -> "VALIDATE & CONNECT"
                    }

                    ConnectExchangeActionButton(
                        text = buttonText,
                        onClick = {
                            hasSubmittedNewConnection = true
                            viewModel.validateAndConnect()
                        },
                        enabled = isFormFilled && !isConnecting,
                        isLoading = isConnecting,
                        testTag = "exchange_connect_button",
                        modifier = Modifier
                            .fillMaxWidth()
                            .widthIn(max = 480.dp)
                    )

                    Spacer(Modifier.height(20.dp))

                    // 5. Bybit Connectivity Checklist (in scrollable view below action button)
                    if (isChangingApiKeys || uiState !is ExchangeUiState.Connected) {
                        BybitConnectivityChecklist()
                        Spacer(Modifier.height(20.dp))
                    }
                }
            }
        }
    }
}

/**
 * Top bar matching the reference: Back Arrow on left, Brand Lockup in center, Logout/Exit on right.
 */
@Composable
private fun ConnectExchangeTopBar(
    onBack: () -> Unit,
    onLogout: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        IconButton(
            onClick = onBack,
            modifier = Modifier.size(40.dp)
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
                tint = Color.White,
                modifier = Modifier.size(24.dp)
            )
        }

        ConnectExchangeHeaderLockup()

        IconButton(
            onClick = onLogout,
            modifier = Modifier.size(40.dp)
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ExitToApp,
                contentDescription = "Logout",
                tint = Color.White,
                modifier = Modifier.size(24.dp)
            )
        }
    }
}

/**
 * Centered Master CryptoPulse Branding Lockup.
 */
@Composable
private fun ConnectExchangeHeaderLockup() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Image(
            painter = painterResource(id = R.drawable.ic_cryptopulse_splash_logo),
            contentDescription = "CryptoPulse Logo",
            modifier = Modifier.size(34.dp),
            contentScale = ContentScale.Fit
        )

        Spacer(Modifier.width(8.dp))

        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "CRYPTO",
                    color = Color.White,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 18.sp,
                    letterSpacing = 1.1.sp,
                )
                Text(
                    text = "PULSE",
                    color = Color(0xFF00B4FF),
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 18.sp,
                    letterSpacing = 1.1.sp,
                )
            }
            Text(
                text = "TRADE SMART. STAY AHEAD.",
                color = Color(0xFF00B4FF).copy(alpha = 0.85f),
                fontSize = 7.5.sp,
                letterSpacing = 1.6.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/**
 * Field section header label.
 */
@Composable
private fun ConnectExchangeFieldLabel(text: String) {
    Text(
        text = text,
        color = Color(0xFF7E9DBF),
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 1.2.sp,
    )
}

/**
 * Glassmorphic container card with electric neon cyan border and ambient halo.
 */
@Composable
private fun ConnectExchangeCardContainer(
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    val cardRadius = 20.dp
    val borderBrush = Brush.verticalGradient(
        listOf(
            Color(0xFF00B4FF),
            Color(0xFF0077E6),
            Color(0xFF0044AA),
        )
    )

    Box(
        modifier = modifier
            .drawBehind {
                // Ambient outer neon glow halo
                drawRoundRect(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color(0x3500B4FF),
                            Color(0x150066FF),
                            Color.Transparent
                        ),
                        center = Offset(size.width / 2f, size.height / 2f),
                        radius = size.width * 0.65f
                    ),
                    cornerRadius = CornerRadius(cardRadius.toPx() + 6.dp.toPx(), cardRadius.toPx() + 6.dp.toPx())
                )
            }
            .clip(RoundedCornerShape(cardRadius))
            .background(
                Brush.verticalGradient(
                    listOf(
                        Color(0xE6081426),
                        Color(0xF2050D1A)
                    )
                )
            )
            .border(
                width = 1.4.dp,
                brush = borderBrush,
                shape = RoundedCornerShape(cardRadius)
            ),
        content = content
    )
}

/**
 * Bybit Exchange display row.
 */
@Composable
private fun ConnectExchangeRow() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Color(0xFF061120))
            .border(1.dp, Color(0xFF18355A), RoundedCornerShape(14.dp))
            .padding(horizontal = 16.dp, vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            text = "Bybit",
            color = Color.White,
            fontWeight = FontWeight.Bold,
            fontSize = 16.sp,
        )
        Text(
            text = "Supported Exchange",
            color = Color(0xFF00B4FF),
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

/**
 * Segmented environment toggle for Demo vs Real.
 */
@Composable
private fun ConnectExchangeEnvironmentToggle(
    selectedEnvironment: String,
    onEnvironmentSelected: (String) -> Unit,
) {
    val options = listOf(
        "demo" to "Demo",
        "mainnet" to "Real",
    )

    LaunchedEffect(selectedEnvironment) {
        if (options.none { it.first.equals(selectedEnvironment, ignoreCase = true) }) {
            onEnvironmentSelected("demo")
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Color(0xFF061120))
            .border(1.dp, Color(0xFF18355A), RoundedCornerShape(14.dp))
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        options.forEach { (value, label) ->
            val selected = selectedEnvironment.equals(value, ignoreCase = true)
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(44.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .then(
                        if (selected) {
                            Modifier
                                .background(
                                    Brush.horizontalGradient(
                                        listOf(
                                            Color(0xFF007FD4),
                                            Color(0xFF00B4FF)
                                        )
                                    )
                                )
                                .border(
                                    width = 1.dp,
                                    color = Color(0xFF60D4FF),
                                    shape = RoundedCornerShape(10.dp)
                                )
                        } else {
                            Modifier.background(Color.Transparent)
                        }
                    )
                    .clickable { onEnvironmentSelected(value) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = label,
                    color = if (selected) Color.White else Color(0xFF7E9DBF),
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                    fontSize = 14.5.sp,
                    letterSpacing = 0.5.sp,
                )
            }
        }
    }
}

/**
 * Text input field matching the reference design with dark container, custom placeholder, and eye toggle.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConnectExchangeInputField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    trailingIcon: @Composable (() -> Unit)? = null,
    isError: Boolean = false,
    testTag: String? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = {
            Text(
                text = placeholder,
                color = Color(0xFF5A738E),
                fontSize = 13.5.sp,
                fontWeight = FontWeight.Normal
            )
        },
        trailingIcon = trailingIcon,
        visualTransformation = visualTransformation,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        singleLine = true,
        isError = isError,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = if (isError) LossRed else Color(0xFF00B4FF),
            unfocusedBorderColor = if (isError) LossRed else Color(0xFF18355A),
            cursorColor = if (isError) LossRed else Color(0xFF00B4FF),
            focusedTextColor = Color(0xFFE8F0FF),
            unfocusedTextColor = Color(0xFFE8F0FF),
            focusedContainerColor = Color(0xFF061120),
            unfocusedContainerColor = Color(0xFF061120),
            errorBorderColor = LossRed,
            errorCursorColor = LossRed,
        ),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
    )
}

/**
 * Full-width action button with the reference's vibrant Cyan-to-Magenta linear gradient,
 * 16dp rounded radius, and clean action text (NO icons or arrows).
 */
@Composable
private fun ConnectExchangeActionButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isLoading: Boolean = false,
    testTag: String? = null,
) {
    val buttonRadius = 16.dp
    val buttonGradient = Brush.horizontalGradient(
        listOf(
            Color(0xFF00A8FF),
            Color(0xFF2563EB),
            Color(0xFF7C3AED),
            Color(0xFFB526FF),
        )
    )

    Button(
        onClick = onClick,
        enabled = enabled && !isLoading,
        shape = RoundedCornerShape(buttonRadius),
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.Transparent,
            disabledContainerColor = Color.Transparent,
        ),
        contentPadding = PaddingValues(0.dp),
        modifier = modifier
            .fillMaxWidth()
            .height(54.dp)
            .drawBehind {
                if (enabled && !isLoading) {
                    // Soft ambient outer glow
                    drawRoundRect(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                Color(0x3500B4FF),
                                Color(0x25B526FF),
                                Color.Transparent
                            ),
                            center = Offset(size.width / 2f, size.height / 2f),
                            radius = size.width * 0.55f
                        ),
                        cornerRadius = CornerRadius(buttonRadius.toPx() + 4.dp.toPx(), buttonRadius.toPx() + 4.dp.toPx())
                    )
                }
            }
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    if (enabled) buttonGradient else Brush.horizontalGradient(listOf(Color(0xFF1E2838), Color(0xFF1E2838))),
                    RoundedCornerShape(buttonRadius)
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (isLoading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.2.dp,
                    color = Color.White
                )
            } else {
                Text(
                    text = text,
                    color = Color.White,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 15.5.sp,
                    letterSpacing = 1.2.sp,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/**
 * Bybit Connectivity Checklist displayed in a dark glassmorphic card.
 */
@Composable
fun BybitConnectivityChecklist() {
    val cardRadius = 16.dp
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .widthIn(max = 480.dp)
            .clip(RoundedCornerShape(cardRadius))
            .background(Color(0xE6081426))
            .border(1.dp, Color(0xFF18355A), RoundedCornerShape(cardRadius))
            .padding(16.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                text = "Bybit Connectivity Checklist",
                color = Color(0xFF00B4FF),
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp,
                modifier = Modifier.padding(bottom = 12.dp)
            )

            Row(
                modifier = Modifier.padding(bottom = 8.dp),
                verticalAlignment = Alignment.Top
            ) {
                Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = null,
                    tint = Color(0xFF00B4FF),
                    modifier = Modifier
                        .size(16.dp)
                        .padding(top = 2.dp)
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "Ensure API Key has 'Unified Trading' or 'Spot & Derivatives' permissions enabled.",
                    color = Color(0xFF94B0D0),
                    fontSize = 12.5.sp,
                    lineHeight = 17.sp
                )
            }

            Row(verticalAlignment = Alignment.Top) {
                Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = null,
                    tint = Color(0xFF00B4FF),
                    modifier = Modifier
                        .size(16.dp)
                        .padding(top = 2.dp)
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "Select 'No IP Restriction' (or configure appropriate static IPs if supported).",
                    color = Color(0xFF94B0D0),
                    fontSize = 12.5.sp,
                    lineHeight = 17.sp
                )
            }
        }
    }
}

/**
 * Ambient bottom horizon reflection flare on the floor of the screen.
 */
@Composable
private fun ConnectExchangeBottomHorizonGlow(
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val center = Offset(w / 2f, h * 0.75f)

        // Diffuse ambient blue
        drawOval(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color(0x450084FF),
                    Color(0x180055CC),
                    Color.Transparent
                ),
                center = center,
                radius = w * 0.45f
            ),
            topLeft = Offset(center.x - w * 0.45f, center.y - 35.dp.toPx()),
            size = Size(w * 0.90f, 70.dp.toPx())
        )

        // Bright cyan horizon core
        drawOval(
            brush = Brush.radialGradient(
                colors = listOf(
                    Color(0xFFB5EFFF),
                    Color(0xDD00B4FF),
                    Color(0x440066FF),
                    Color.Transparent
                ),
                center = center,
                radius = w * 0.20f
            ),
            topLeft = Offset(center.x - w * 0.20f, center.y - 7.dp.toPx()),
            size = Size(w * 0.40f, 14.dp.toPx())
        )
    }
}
