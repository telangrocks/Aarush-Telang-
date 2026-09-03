package com.cryptopulse.app.ui.auth

import com.cryptopulse.app.core.network.*

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
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
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
    var emailVisible by remember { mutableStateOf(true) }
    var passwordVisible by remember { mutableStateOf(false) }

    // This screen is Sign In only. New-account creation lives on the dedicated
    // UserOnboardingScreen, so we avoid a second, redundant registration surface.
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
                .padding(padding),
            contentAlignment = Alignment.Center
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .widthIn(max = 480.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Spacer(Modifier.height(8.dp))

                Text(
                    text = "SIGN IN",
                    color = CyanPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 22.sp,
                    letterSpacing = 1.5.sp,
                )

                Spacer(Modifier.height(6.dp))

                Text(
                    text = "Sign in with your email and password to access your trading dashboard.",
                    color = TextSecondary,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    lineHeight = 18.sp,
                )

                Spacer(Modifier.height(20.dp))

                GlowCard(
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp)
                    ) {
                        Text(
                            text = "ENTER CREDENTIALS",
                            color = CyanPrimary,
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp,
                            letterSpacing = 1.2.sp,
                        )

                        Spacer(Modifier.height(14.dp))

                        AuthFieldLabel("EMAIL ADDRESS")
                        Spacer(Modifier.height(6.dp))
                        DarkTextField(
                            value = viewModel.email,
                            onValueChange = { viewModel.email = it },
                            placeholder = "Enter your email address",
                            keyboardType = KeyboardType.Email,
                            visualTransformation = if (emailVisible) VisualTransformation.None else PasswordVisualTransformation(),
                            isError = viewModel.emailError != null,
                            testTag = "auth_email_input",
                            trailingIcon = {
                                IconButton(onClick = { emailVisible = !emailVisible }) {
                                    Icon(
                                        imageVector = if (emailVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                        contentDescription = if (emailVisible) "Hide email" else "Show email",
                                        tint = TextSecondary,
                                        modifier = Modifier.size(18.dp)
                                    )
                                }
                            }
                        )
                        if (viewModel.emailError != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = viewModel.emailError!!,
                                color = LossRed,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(start = 4.dp)
                            )
                        }

                        Spacer(Modifier.height(14.dp))

                        AuthFieldLabel("PASSWORD")
                        Spacer(Modifier.height(6.dp))
                        DarkTextField(
                            value = viewModel.password,
                            onValueChange = { viewModel.password = it },
                            placeholder = "Enter your password",
                            keyboardType = KeyboardType.Password,
                            visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                            isError = viewModel.passwordError != null,
                            testTag = "auth_password_input",
                            trailingIcon = {
                                IconButton(onClick = { passwordVisible = !passwordVisible }) {
                                    Icon(
                                        imageVector = if (passwordVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                        contentDescription = if (passwordVisible) "Hide password" else "Show password",
                                        tint = TextSecondary,
                                        modifier = Modifier.size(20.dp)
                                    )
                                }
                            }
                        )
                        if (viewModel.passwordError != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = viewModel.passwordError!!,
                                color = LossRed,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(start = 4.dp)
                            )
                        }
                    }
                }

                Spacer(Modifier.height(20.dp))

                GradientButton(
                    text = if (viewModel.isLoading) "Signing in…" else "Sign In",
                    onClick = { viewModel.login() },
                    enabled = !viewModel.isLoading,
                    testTag = "auth_sign_in_button",
                )

                Spacer(Modifier.height(20.dp))
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
    testTag: String? = null,
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
        modifier = Modifier.fillMaxWidth().then(
            if (testTag != null) Modifier.testTag(testTag) else Modifier
        ),
    )
}



