package com.cryptopulse.app.ui.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Login
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.theme.CyanPrimary
import com.cryptopulse.app.ui.theme.LossRed
import com.cryptopulse.app.ui.theme.NavyBorder
import com.cryptopulse.app.ui.theme.NavyCard
import com.cryptopulse.app.ui.theme.NavyDark
import com.cryptopulse.app.ui.theme.NavyDeep
import com.cryptopulse.app.ui.theme.TextMuted
import com.cryptopulse.app.ui.theme.TextPrimary
import com.cryptopulse.app.ui.theme.TextSecondary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuthScreen(
    viewModel: AuthViewModel,
    onAuthSuccess: () -> Unit,
) {
    var isLoginMode by remember { mutableStateOf(true) }

    LaunchedEffect(viewModel.isAuthenticated) {
        if (viewModel.isAuthenticated) onAuthSuccess()
    }

    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    Scaffold(
        topBar = { CryptoPulseTopBar() },
        containerColor = Color.Transparent,
        snackbarHost = {
            if (viewModel.errorMessage != null) {
                Snackbar(
                    modifier = Modifier.padding(16.dp),
                    containerColor = Color(0xFF1A0A10),
                    contentColor = LossRed,
                    action = {
                        TextButton(onClick = { viewModel.clearError() }) {
                            Text("Dismiss", color = LossRed)
                        }
                    }
                ) { Text(viewModel.errorMessage!!) }
            }
        }
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
                    .padding(horizontal = 20.dp, vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(8.dp))

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    Icon(
                        imageVector = if (isLoginMode) Icons.Default.Login else Icons.Default.PersonAdd,
                        contentDescription = null,
                        tint = CyanPrimary,
                        modifier = Modifier.size(26.dp)
                    )
                    Spacer(Modifier.width(10.dp))
                    Text(
                        text = if (isLoginMode) "SIGN IN" else "CREATE ACCOUNT",
                        color = CyanPrimary,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 22.sp,
                        letterSpacing = 1.5.sp,
                    )
                }

                Spacer(Modifier.height(6.dp))

                Text(
                    text = if (isLoginMode) {
                        "Sign in with your email and password to access your trading dashboard."
                    } else {
                        "Create your account with email and password to start your trading journey."
                    },
                    color = TextSecondary,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    lineHeight = 20.sp,
                )

                Spacer(Modifier.height(20.dp))

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0x1400B4FF), RoundedCornerShape(12.dp))
                        .padding(4.dp),
                ) {
                    AuthModeButton(
                        text = "Create Account",
                        selected = !isLoginMode,
                        onClick = {
                            isLoginMode = false
                            viewModel.clearError()
                        },
                        modifier = Modifier.weight(1f),
                    )
                    AuthModeButton(
                        text = "Sign In",
                        selected = isLoginMode,
                        onClick = {
                            isLoginMode = true
                            viewModel.clearError()
                        },
                        modifier = Modifier.weight(1f),
                    )
                }

                Spacer(Modifier.height(20.dp))

                GlowCard {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Default.AccountCircle,
                                contentDescription = null,
                                tint = CyanPrimary,
                                modifier = Modifier.size(18.dp)
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = "ENTER CREDENTIALS",
                                color = CyanPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                letterSpacing = 1.2.sp,
                            )
                        }

                        Spacer(Modifier.height(16.dp))

                        AuthFieldLabel("EMAIL ADDRESS")
                        Spacer(Modifier.height(4.dp))
                        DarkTextField(
                            value = viewModel.email,
                            onValueChange = { viewModel.email = it },
                            placeholder = "Enter your email address",
                            keyboardType = KeyboardType.Email,
                            trailingIcon = {
                                Icon(Icons.Default.Email, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                            }
                        )

                        Spacer(Modifier.height(14.dp))

                        AuthFieldLabel("PASSWORD")
                        Spacer(Modifier.height(4.dp))
                        DarkTextField(
                            value = viewModel.password,
                            onValueChange = { viewModel.password = it },
                            placeholder = if (isLoginMode) "Enter your password" else "Min. 8 chars, A-Z, a-z, 0-9, symbol",
                            keyboardType = KeyboardType.Password,
                            visualTransformation = PasswordVisualTransformation(),
                            trailingIcon = {
                                Icon(Icons.Default.Lock, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
                            }
                        )
                    }
                }

                Spacer(Modifier.height(14.dp))

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
                        text = if (isLoginMode) {
                            "Use the same email and password you created during signup."
                        } else {
                            "We are using simple email and password authentication for now so you can get into the app quickly."
                        },
                        color = TextSecondary,
                        fontSize = 11.sp,
                        lineHeight = 17.sp,
                    )
                }

                Spacer(Modifier.height(20.dp))

                GradientButton(
                    text = when {
                        viewModel.isLoading && isLoginMode -> "Signing in…"
                        viewModel.isLoading -> "Creating account…"
                        isLoginMode -> "Sign In"
                        else -> "Create Account"
                    },
                    onClick = {
                        if (isLoginMode) {
                            viewModel.login()
                        } else {
                            viewModel.register()
                        }
                    },
                    enabled = !viewModel.isLoading,
                    leadingIcon = if (isLoginMode) Icons.Default.Login else Icons.Default.Shield,
                    trailingIcon = Icons.Default.ArrowForward,
                )

                Spacer(Modifier.height(14.dp))

                Row(
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.Lock, null, tint = TextMuted, modifier = Modifier.size(12.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("Secure Connection", color = TextMuted, fontSize = 11.sp)
                }
                Text(
                    "We support all major exchanges",
                    color = TextMuted,
                    fontSize = 10.sp,
                    modifier = Modifier.padding(top = 2.dp)
                )

                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@Composable
fun AuthModeButton(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    TextButton(
        onClick = onClick,
        modifier = modifier
            .background(
                if (selected) CyanPrimary.copy(alpha = 0.15f) else Color.Transparent,
                RoundedCornerShape(10.dp),
            )
    ) {
        Text(
            text = text,
            color = if (selected) CyanPrimary else TextSecondary,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
        )
    }
}

@Composable
fun AuthFieldLabel(text: String) {
    Text(
        text = text,
        color = TextSecondary,
        fontSize = 10.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.8.sp,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DarkTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    keyboardType: KeyboardType = KeyboardType.Text,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    isError: Boolean = false,
    trailingIcon: @Composable (() -> Unit)? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(placeholder, color = TextMuted, fontSize = 13.sp) },
        trailingIcon = trailingIcon,
        visualTransformation = visualTransformation,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        singleLine = true,
        isError = isError,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = if (isError) LossRed else CyanPrimary,
            unfocusedBorderColor = if (isError) LossRed else NavyBorder,
            cursorColor = if (isError) LossRed else CyanPrimary,
            focusedTextColor = TextPrimary,
            unfocusedTextColor = TextPrimary,
            focusedContainerColor = NavyCard,
            unfocusedContainerColor = NavyCard,
            errorBorderColor = LossRed,
            errorCursorColor = LossRed,
        ),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth(),
    )
}
