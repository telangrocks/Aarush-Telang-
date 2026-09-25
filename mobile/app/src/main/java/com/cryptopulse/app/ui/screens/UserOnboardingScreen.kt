package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.cryptopulse.app.R
import com.cryptopulse.app.ui.auth.AuthViewModel
import com.cryptopulse.app.ui.theme.*

/**
 * Refurbished Create Account Screen matching the reference design:
 *  – Deep midnight cosmic background with radiant bottom horizon flare
 *  – Seamless integrated branded header lockup with Master Logo
 *  – "CREATE ACCOUNT" in neon cyan + "Start Your Crypto Journey with CryptoPulse"
 *  – Glowing glassmorphic input card with neon cyan border and ambient halo
 *  – Custom fields with leading icons (Mail, Lock) and trailing icons (Account, Visibility)
 *  – Action buttons with vibrant Cyan-to-Magenta gradient (NO icons/arrows)
 *  – 100% preserved authentication, registration, validation, error handling, and navigation logic
 */
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

    val bgGradient = Brush.verticalGradient(
        0.0f to Color(0xFF000916),
        0.35f to Color(0xFF000B1B),
        0.65f to Color(0xFF000D1E),
        1.0f to Color(0xFF000814)
    )

    Scaffold(
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
                .padding(padding)
        ) {
            // Ambient Bottom Horizon Flare
            BottomHorizonGlow(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(140.dp)
                    .align(Alignment.BottomCenter)
            )

            // Scrollable Content Stack
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .navigationBarsPadding()
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(16.dp))

                // 1. Integrated Branded Header Lockup
                CreateAccountHeaderLockup()

                Spacer(Modifier.height(32.dp))

                // 2. Heading & Subtitle
                Text(
                    text = "CREATE ACCOUNT",
                    color = Color(0xFF00B4FF),
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 26.sp,
                    letterSpacing = 1.8.sp,
                    textAlign = TextAlign.Center
                )

                Spacer(Modifier.height(8.dp))

                Text(
                    text = "Start Your Crypto Journey with CryptoPulse",
                    color = Color(0xFF94B0D0),
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.Medium,
                    letterSpacing = 0.4.sp,
                    textAlign = TextAlign.Center
                )

                Spacer(Modifier.height(26.dp))

                // 3. Glowing Glassmorphic Input Card Container
                CreateAccountCardContainer(
                    modifier = Modifier
                        .fillMaxWidth()
                        .widthIn(max = 480.dp)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 18.dp, vertical = 22.dp)
                    ) {
                        // Email Field
                        CreateAccountFieldLabel("EMAIL ADDRESS")
                        Spacer(Modifier.height(8.dp))
                        CreateAccountInputField(
                            value = viewModel.email,
                            onValueChange = { viewModel.email = it },
                            placeholder = "Enter your email address",
                            keyboardType = KeyboardType.Email,
                            leadingIcon = Icons.Default.Email,
                            trailingIcon = {
                                Icon(
                                    imageVector = Icons.Default.AccountCircle,
                                    contentDescription = null,
                                    tint = Color(0xFF5B7B9E),
                                    modifier = Modifier.size(22.dp)
                                )
                            },
                            isError = viewModel.emailError != null,
                            testTag = "onboarding_email_input"
                        )
                        if (viewModel.emailError != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = viewModel.emailError!!,
                                color = LossRed,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(start = 6.dp)
                            )
                        }

                        Spacer(Modifier.height(18.dp))

                        // Password Field
                        CreateAccountFieldLabel("PASSWORD")
                        Spacer(Modifier.height(8.dp))
                        CreateAccountInputField(
                            value = viewModel.password,
                            onValueChange = { viewModel.password = it },
                            placeholder = "Min. 8 characters",
                            keyboardType = KeyboardType.Password,
                            visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                            leadingIcon = Icons.Default.Lock,
                            trailingIcon = {
                                IconButton(onClick = { passwordVisible = !passwordVisible }) {
                                    Icon(
                                        imageVector = if (passwordVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                        contentDescription = if (passwordVisible) "Hide password" else "Show password",
                                        tint = Color(0xFF5B7B9E),
                                        modifier = Modifier.size(20.dp)
                                    )
                                }
                            },
                            isError = viewModel.passwordError != null,
                            testTag = "onboarding_password_input"
                        )
                        if (viewModel.passwordError != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = viewModel.passwordError!!,
                                color = LossRed,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(start = 6.dp)
                            )
                        }

                        Spacer(Modifier.height(18.dp))

                        // Confirm Password Field
                        CreateAccountFieldLabel("CONFIRM PASSWORD")
                        Spacer(Modifier.height(8.dp))
                        CreateAccountInputField(
                            value = viewModel.confirmPassword,
                            onValueChange = { viewModel.confirmPassword = it },
                            placeholder = "Re-enter your password",
                            keyboardType = KeyboardType.Password,
                            visualTransformation = if (confirmPasswordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                            leadingIcon = Icons.Default.Lock,
                            trailingIcon = {
                                IconButton(onClick = { confirmPasswordVisible = !confirmPasswordVisible }) {
                                    Icon(
                                        imageVector = if (confirmPasswordVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                        contentDescription = if (confirmPasswordVisible) "Hide password" else "Show password",
                                        tint = Color(0xFF5B7B9E),
                                        modifier = Modifier.size(20.dp)
                                    )
                                }
                            },
                            isError = viewModel.confirmPasswordError != null,
                            testTag = "onboarding_confirm_password_input"
                        )
                        if (viewModel.confirmPasswordError != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = viewModel.confirmPasswordError!!,
                                color = LossRed,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(start = 6.dp)
                            )
                        }
                    }
                }

                Spacer(Modifier.height(26.dp))

                // 4. Primary Action: CREATE ACCOUNT (Cyan-to-Magenta gradient, NO icons)
                CreateAccountGradientButton(
                    text = if (viewModel.isLoading) "CREATING ACCOUNT…" else "CREATE ACCOUNT",
                    onClick = { viewModel.register() },
                    enabled = !viewModel.isLoading,
                    isLoading = viewModel.isLoading,
                    testTag = "onboarding_create_account_button",
                    modifier = Modifier
                        .fillMaxWidth()
                        .widthIn(max = 480.dp)
                )

                Spacer(Modifier.height(14.dp))

                // 5. Secondary Action: ALREADY REGISTERED? LOGIN (Cyan-to-Magenta gradient, NO icons)
                CreateAccountGradientButton(
                    text = "ALREADY REGISTERED? LOGIN",
                    onClick = { navController.navigate("auth") },
                    testTag = "onboarding_login_button",
                    modifier = Modifier
                        .fillMaxWidth()
                        .widthIn(max = 480.dp)
                )

                Spacer(Modifier.height(36.dp))
            }
        }
    }
}

/**
 * Header lockup displaying Master Logo + "CRYPTO PULSE" + "TRADE SMART. STAY AHEAD."
 */
@Composable
private fun CreateAccountHeaderLockup() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Image(
            painter = painterResource(id = R.drawable.ic_cryptopulse_splash_logo),
            contentDescription = "CryptoPulse Logo",
            modifier = Modifier.size(38.dp),
            contentScale = ContentScale.Fit
        )

        Spacer(Modifier.width(10.dp))

        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "CRYPTO",
                    color = Color.White,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 20.sp,
                    letterSpacing = 1.2.sp,
                )
                Text(
                    text = "PULSE",
                    color = Color(0xFF00B4FF),
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 20.sp,
                    letterSpacing = 1.2.sp,
                )
            }
            Text(
                text = "TRADE SMART. STAY AHEAD.",
                color = Color(0xFF7C98B6),
                fontSize = 8.sp,
                letterSpacing = 1.8.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/**
 * Field section header label.
 */
@Composable
private fun CreateAccountFieldLabel(text: String) {
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
private fun CreateAccountCardContainer(
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
 * Input field matching the reference design with leading icon, custom placeholder, and trailing icon.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CreateAccountInputField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    keyboardType: KeyboardType = KeyboardType.Text,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    leadingIcon: ImageVector? = null,
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
        leadingIcon = leadingIcon?.let {
            {
                Icon(
                    imageVector = it,
                    contentDescription = null,
                    tint = Color(0xFF5B7B9E),
                    modifier = Modifier.size(20.dp)
                )
            }
        },
        trailingIcon = trailingIcon,
        visualTransformation = visualTransformation,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
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
 * Full-width button with the reference's vibrant Cyan-to-Magenta linear gradient,
 * 16dp rounded radius, and clean action text (NO icons).
 */
@Composable
private fun CreateAccountGradientButton(
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
                if (enabled) {
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
                    fontSize = 15.sp,
                    letterSpacing = 1.2.sp,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/**
 * Ambient bottom horizon reflection flare on the floor of the screen.
 */
@Composable
private fun BottomHorizonGlow(
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
