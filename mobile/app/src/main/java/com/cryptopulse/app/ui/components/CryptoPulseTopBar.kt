package com.cryptopulse.app.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.ui.theme.CyanPrimary
import com.cryptopulse.app.ui.theme.NavyDeep
import com.cryptopulse.app.ui.theme.TextPrimary
import com.cryptopulse.app.ui.theme.TextSecondary

/**
 * Logout handler provided by the host activity so the branded top bar can expose
 * a sign-out action without every screen threading the callback explicitly.
 * Null when the user is not authenticated (button is hidden).
 */
val LocalOnLogout = compositionLocalOf<(() -> Unit)?> { null }

/**
 * The branded top bar used on every screen of the app.
 *
 * Shows the CryptoPulse wordmark centred, with an optional back-arrow on the
 * left side. The look matches the reference screenshots exactly.
 *
 * @param onBack  If non-null, a back-arrow icon button is shown and calls this
 *                lambda when tapped. Pass null for screens without a back action.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CryptoPulseTopBar(
    onBack: (() -> Unit)? = null,
    onLogout: (() -> Unit)? = LocalOnLogout.current,
) {
    TopAppBar(
        modifier = Modifier.fillMaxWidth(),
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = NavyDeep,
        ),
        navigationIcon = {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(
                        imageVector = Icons.Default.ArrowBack,
                        contentDescription = "Back",
                        tint = TextPrimary
                    )
                }
            } else {
                // Reserve the same width so the title stays centred
                Spacer(Modifier.width(48.dp))
            }
        },
        title = {
            // Centre the wordmark regardless of navigation-icon presence
            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.Center
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    // Logo row — icon + wordmark side-by-side
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center
                    ) {
                        // Circular logo placeholder drawn in code
                        CryptoPulseLogoIcon(size = 28.dp)
                        Spacer(Modifier.width(6.dp))
                        // CRYPTOPULSE wordmark split into two weights
                        Text(
                            text = "CRYPTO",
                            color = TextPrimary,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 15.sp,
                            letterSpacing = 1.sp,
                        )
                        Text(
                            text = "PULSE",
                            color = CyanPrimary,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 15.sp,
                            letterSpacing = 1.sp,
                        )
                    }
                    // Tagline
                    Text(
                        text = "TRADE SMART. STAY AHEAD.",
                        color = TextSecondary,
                        fontSize = 7.sp,
                        letterSpacing = 1.2.sp,
                        textAlign = TextAlign.Center
                    )
                }
            }
        },
        actions = {
            if (onLogout != null) {
                IconButton(onClick = onLogout) {
                    Icon(
                        imageVector = Icons.Default.Logout,
                        contentDescription = "Log out",
                        tint = TextPrimary
                    )
                }
            } else {
                // Reserve the same space as navigation icon so title stays centred
                Spacer(Modifier.width(48.dp))
            }
        }
    )
}
