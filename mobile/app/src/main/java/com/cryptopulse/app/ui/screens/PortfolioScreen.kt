package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.theme.*
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import java.text.NumberFormat
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PortfolioScreen(
    onBack: () -> Unit = {},
    viewModel: ExchangeViewModel = hiltViewModel(),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    val balances by viewModel.balances.collectAsState()
    val balancesError by viewModel.balancesError.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.fetchBalances()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgGradient)
    ) {
        Scaffold(
            topBar = { CryptoPulseTopBar(onBack = onBack) },
            containerColor = Color.Transparent,
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 16.dp)
            ) {
                val currentBalances = balances
                if (balancesError != null) {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(text = balancesError!!, color = LossRed, textAlign = TextAlign.Center)
                    }
                } else if (currentBalances == null) {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = CyanPrimary)
                    }
                } else if (currentBalances.isEmpty()) {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(text = "No current holdings.", color = TextSecondary, textAlign = TextAlign.Center)
                    }
                } else {
                    Text(
                        text = "Current Holdings",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        fontSize = 18.sp,
                        modifier = Modifier.padding(vertical = 16.dp)
                    )

                    LazyColumn(
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        items(currentBalances.filter { it.total > 0 }) { balance ->
                            BalanceItemCard(
                                asset = balance.asset,
                                free = balance.free,
                                locked = balance.locked,
                                total = balance.total
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun BalanceItemCard(asset: String, free: Double, locked: Double, total: Double) {
    val formatter = remember {
        NumberFormat.getNumberInstance(Locale.US).apply {
            minimumFractionDigits = 2
            maximumFractionDigits = 6
        }
    }
    GlowCard(
        modifier = Modifier.fillMaxWidth(),
        borderColor = CyanPrimary
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = asset,
                    color = Color.White,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 20.sp
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Total: ${formatter.format(total)}",
                    color = TextSecondary,
                    fontSize = 14.sp
                )
            }

            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = "Available: ${formatter.format(free)}",
                    color = CyanPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp
                )
                Spacer(modifier = Modifier.height(4.dp))
                if (locked > 0) {
                    Text(
                        text = "In Orders: ${formatter.format(locked)}",
                        color = LossRed,
                        fontSize = 12.sp
                    )
                }
            }
        }
    }
}

