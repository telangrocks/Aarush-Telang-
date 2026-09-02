package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.PersonAdd
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.cryptopulse.app.ui.components.*
import com.cryptopulse.app.ui.auth.*
import com.cryptopulse.app.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UserOnboardingScreen(navController: NavController, viewModel: AuthViewModel) {
    var passwordVisible by remember { mutableStateOf(false) }
    var confirmPasswordVisible by remember { mutableStateOf(false) }

    LaunchedEffect(viewModel.isAuthenticated) {
        if (viewModel.isAuthenticated) {
            navController.navigate("connect_exchange") {
                popUpTo("onboarding") { inclusive = true }
            }
        }
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
                    text = "CREATE ACCOUNT",
                    color = CyanPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 22.sp,
                    letterSpacing = 1.5.sp,
                )

                Spacer(Modifier.height(6.dp))

                Text(
                    text = "Start trading with a secure CryptoPulse account",
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
                        AuthFieldLabel("EMAIL ADDRESS")
                        Spacer(Modifier.height(6.dp))
                        DarkTextField(
                            value = viewModel.email,
                            onValueChange = { viewModel.email = it },
                            placeholder = "Enter your email address",
                            keyboardType = KeyboardType.Email,
                            isError = viewModel.emailError != null,
                            testTag = "onboarding_email_input",
                            trailingIcon = {
                                Icon(Icons.Default.Email, null, tint = TextSecondary, modifier = Modifier.size(18.dp))
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
                            placeholder = "Min. 8 characters",
                            keyboardType = KeyboardType.Password,
                            visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                            isError = viewModel.passwordError != null,
                            testTag = "onboarding_password_input",
                            trailingIcon = {
                                IconButton(onClick = { passwordVisible = !passwordVisible }) {
                                    Icon(
                                        imageVector = if (passwordVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                        contentDescription = if (passwordVisible) "Hide password" else "Show password",
                                        tint = TextSecondary,
                                        modifier = Modifier.size(18.dp)
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

                        Spacer(Modifier.height(14.dp))

                        AuthFieldLabel("CONFIRM PASSWORD")
                        Spacer(Modifier.height(6.dp))
                        DarkTextField(
                            value = viewModel.confirmPassword,
                            onValueChange = { viewModel.confirmPassword = it },
                            placeholder = "Re-enter your password",
                            keyboardType = KeyboardType.Password,
                            visualTransformation = if (confirmPasswordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                            isError = viewModel.confirmPasswordError != null,
                            testTag = "onboarding_confirm_password_input",
                            trailingIcon = {
                                IconButton(onClick = { confirmPasswordVisible = !confirmPasswordVisible }) {
                                    Icon(
                                        imageVector = if (confirmPasswordVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                        contentDescription = if (confirmPasswordVisible) "Hide password" else "Show password",
                                        tint = TextSecondary,
                                        modifier = Modifier.size(18.dp)
                                    )
                                }
                            }
                        )
                        if (viewModel.confirmPasswordError != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = viewModel.confirmPasswordError!!,
                                color = LossRed,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(start = 4.dp)
                            )
                        }
                    }
                }

                Spacer(Modifier.height(20.dp))

                GradientButton(
                    text = when {
                        viewModel.isLoading -> "Creating account…"
                        else -> "Create Account"
                    },
                    onClick = { viewModel.register() },
                    enabled = !viewModel.isLoading,
                    testTag = "onboarding_create_account_button",
                )

                Spacer(Modifier.height(12.dp))

                GradientButton(
                    text = "Already Registered? Login",
                    onClick = { navController.navigate("auth") },
                    testTag = "onboarding_login_button",
                )

                Spacer(Modifier.height(20.dp))
            }
        }
    }
}

