package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.activity.ComponentActivity
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.R
import com.cryptopulse.app.ui.components.LocalOnLogout
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.theme.*
import com.cryptopulse.app.ui.utils.Formatters
import java.text.SimpleDateFormat
import java.util.*

// ─── Data model for the screen ────────────────────────────────────────────────
@Immutable
data class MarketCandidate(
    val rank: Int = 0,
    val symbol: String = "",
    val pairName: String = "",
    val coinName: String = "",
    val notations: Int = 0,
    val currentMarketPrice: Double = 0.0,
    val minNotional: Double? = null,
    val minOrderQty: Double? = null,
    val qtyStep: Double? = null,
    val tickSize: Double? = null,
    val minPrice: Double? = null,
    val maxPrice: Double? = null,
    val maxQty: Double? = null,
    val coinColor: Color = Color.Unspecified,
    val volume24h: Double = 0.0,
    val quoteVolume24h: Double = 0.0,
    val priceChangePercent24h: Double = 0.0,
    val score: Double = 0.0,
    val tradeSide: String = "",
    val formattedPrice: String = "",
    val formattedMinNotional: String = "",
    val formattedVolume: String = "",
    val highPrice24h: Double = 0.0,
    val lowPrice24h: Double = 0.0,
    val category: String = "linear",
    val exchangeTimestamp: Long = 0L,
    val opportunityId: String? = null,
    val recommendedStrategy: String? = null
)

fun MarketCandidate.toAccessibilityDescription(): String {
    val priceStr = Formatters.formatCryptoPrice(currentMarketPrice)
    val pctStr = Formatters.formatPercentage(priceChangePercent24h)
    val volStr = Formatters.formatQuoteVolume(quoteVolume24h)
    val minStr = Formatters.formatMinNotional(minNotional ?: 0.0)
    val scoreStr = Formatters.formatScore(score)
    val sideText = if (tradeSide.isNotBlank()) "$tradeSide." else ""
    val directionText = if (priceChangePercent24h >= 0) "Up" else "Down"
    return "Rank $rank. $pairName. $sideText Price $priceStr dollars. $directionText $pctStr. Technical Score $scoreStr. 24 hour volume $volStr. Minimum order $minStr."
}

// ─────────────────────────────────────────────────────────────────────────────
// Market Candidates Screen
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun MarketCandidatesScreen(
    onCandidateClick: (MarketCandidate) -> Unit,
    onSetUpTrading: () -> Unit = {},
    onBack: (() -> Unit)? = null,
    onIncreaseBudget: (() -> Unit)? = null,
    onChangeApiKeys: (() -> Unit)? = null,
    budget: Double = 5.0,
    viewModel: com.cryptopulse.app.ui.auth.ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
) {
    android.util.Log.d("VM_CHECK", "[DIAGNOSTIC] MarketCandidatesScreen ExchangeViewModel hash=${System.identityHashCode(viewModel)}")

    LaunchedEffect(Unit) {
        android.util.Log.d("MarketCandidatesScreen", "[DIAGNOSTIC] SCREEN CREATED")
    }

    val candidates by viewModel.candidates.collectAsState(initial = emptyList())
    val candidatesLoading by viewModel.candidatesLoading.collectAsState(initial = false)
    val candidatesError by viewModel.candidatesError.collectAsState(initial = null)
    val marketDataState by viewModel.marketDataState.collectAsState(initial = com.cryptopulse.app.ui.auth.MarketDataUiState.Idle)
    
    android.util.Log.d("MarketCandidatesScreen", "[DIAGNOSTIC] Recomposed: VM hash=${System.identityHashCode(viewModel)}, candidatesCount=${candidates.size}, marketDataState=$marketDataState")

    val mappedCandidates = candidates
    val bgGradient = Brush.verticalGradient(
        0.0f to Color(0xFF000916),
        0.35f to Color(0xFF000B1B),
        0.65f to Color(0xFF000D1E),
        1.0f to Color(0xFF000814)
    )
    val listState = rememberLazyListState()

    var currentTime by remember { mutableStateOf(getCurrentTime()) }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(1000)
            currentTime = getCurrentTime()
        }
    }

    val onLogout = LocalOnLogout.current

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgGradient)
    ) {
        // Ambient Bottom Horizon Flare
        MarketCandidatesBottomHorizonGlow(
            modifier = Modifier
                .fillMaxWidth()
                .height(140.dp)
                .align(Alignment.BottomCenter)
        )

        Scaffold(
            topBar = {
                MarketCandidatesTopBar(
                    onBack = onBack,
                    onRefresh = {
                        if (!candidatesLoading) {
                            viewModel.fetchMarketCandidates(budget)
                        }
                    },
                    isRefreshing = candidatesLoading,
                    onLogout = { onLogout?.invoke() ?: onBack?.invoke() }
                )
            },
            bottomBar = {
                if (mappedCandidates.isNotEmpty() && !candidatesLoading && candidatesError == null) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .navigationBarsPadding()
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .widthIn(max = 680.dp)
                        ) {
                            GradientButton(
                                text = "SET UP TRADING",
                                onClick = onSetUpTrading,
                                leadingIcon = Icons.Default.Tune,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(54.dp)
                                    .testTag("set_up_trading_button")
                            )
                        }
                    }
                }
            },
            containerColor = Color.Transparent,
        ) { padding ->

            when (val state = marketDataState) {
                is com.cryptopulse.app.ui.auth.MarketDataUiState.Error -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(padding)
                            .testTag("market_candidates_error"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .widthIn(max = 480.dp)
                                .clip(RoundedCornerShape(16.dp))
                                .background(Color(0xE6081426))
                                .border(1.dp, Color(0xFF18355A), RoundedCornerShape(16.dp))
                                .padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            Icon(
                                Icons.Default.WifiOff,
                                contentDescription = null,
                                tint = LossRed,
                                modifier = Modifier.size(40.dp)
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(
                                state.message,
                                color = Color(0xFF94B0D0),
                                fontSize = 14.sp,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.padding(horizontal = 16.dp)
                            )
                            state.hint?.let { hint ->
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    hint,
                                    color = Color(0xFF94B0D0).copy(alpha = 0.7f),
                                    fontSize = 12.sp,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.padding(horizontal = 16.dp)
                                )
                            }
                            Spacer(Modifier.height(16.dp))
                            GradientButton(
                                text = "Retry",
                                onClick = { viewModel.clearCandidatesError(); viewModel.fetchMarketCandidates(budget) },
                                leadingIcon = Icons.Default.Refresh,
                                modifier = Modifier.fillMaxWidth(0.7f).widthIn(max = 280.dp),
                                testTag = "market_candidates_retry"
                            )
                        }
                    }
                    return@Scaffold
                }

                is com.cryptopulse.app.ui.auth.MarketDataUiState.Loading -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(padding)
                            .testTag("market_candidates_loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator(
                                color = Color(0xFF00B4FF),
                                modifier = Modifier.size(38.dp),
                                strokeWidth = 2.5.dp
                            )
                            Spacer(Modifier.height(16.dp))
                            Text("Analyzing market data...", color = Color(0xFF94B0D0), fontSize = 14.sp)
                        }
                    }
                    return@Scaffold
                }

                is com.cryptopulse.app.ui.auth.MarketDataUiState.Empty -> {
                    val formattedBudget = if (budget % 1.0 == 0.0) {
                        budget.toInt().toString()
                    } else {
                        String.format(java.util.Locale.US, "%.2f", budget).trimEnd('0').trimEnd('.')
                    }
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(padding)
                            .testTag("market_candidates_empty"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .widthIn(max = 480.dp)
                                .clip(RoundedCornerShape(16.dp))
                                .background(Color(0xE6081426))
                                .border(1.dp, Color(0xFF18355A), RoundedCornerShape(16.dp))
                                .padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            Icon(
                                Icons.Default.SearchOff,
                                contentDescription = null,
                                tint = Color(0xFF00B4FF),
                                modifier = Modifier.size(44.dp)
                            )
                            Spacer(Modifier.height(14.dp))
                            Text(
                                text = "No Opportunities Within Your Budget",
                                color = Color.White,
                                fontSize = 18.sp,
                                fontWeight = FontWeight.Bold,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.padding(horizontal = 16.dp)
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = "There are currently no eligible trading opportunities available within your $formattedBudget USDT trade budget. Please increase your budget and try again.",
                                color = Color(0xFF94B0D0),
                                fontSize = 14.sp,
                                lineHeight = 20.sp,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.padding(horizontal = 16.dp)
                            )
                            Spacer(Modifier.height(20.dp))
                            GradientButton(
                                text = "Increase Budget",
                                onClick = { onIncreaseBudget?.invoke() ?: onBack?.invoke() },
                                leadingIcon = Icons.Default.Tune,
                                modifier = Modifier.fillMaxWidth(0.75f).widthIn(max = 280.dp),
                                testTag = "market_candidates_increase_budget"
                            )
                        }
                    }
                    return@Scaffold
                }

                else -> {
                    if (candidatesError != null) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(padding)
                                .testTag("market_candidates_error"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .widthIn(max = 480.dp)
                                    .clip(RoundedCornerShape(16.dp))
                                    .background(Color(0xE6081426))
                                    .border(1.dp, Color(0xFF18355A), RoundedCornerShape(16.dp))
                                    .padding(24.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                Icon(
                                    Icons.Default.WifiOff,
                                    contentDescription = null,
                                    tint = LossRed,
                                    modifier = Modifier.size(40.dp)
                                )
                                Spacer(Modifier.height(12.dp))
                                Text(
                                    candidatesError ?: "Failed to load market candidates.",
                                    color = Color(0xFF94B0D0),
                                    fontSize = 14.sp,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.padding(horizontal = 16.dp)
                                )
                                Spacer(Modifier.height(16.dp))
                                GradientButton(
                                    text = "Retry",
                                    onClick = { viewModel.clearCandidatesError(); viewModel.fetchMarketCandidates(budget) },
                                    leadingIcon = Icons.Default.Refresh,
                                    modifier = Modifier.fillMaxWidth(0.7f).widthIn(max = 280.dp),
                                    testTag = "market_candidates_retry"
                                )
                            }
                        }
                        return@Scaffold
                    }

                    if (candidatesLoading) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(padding)
                                .testTag("market_candidates_loading"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                CircularProgressIndicator(
                                    color = Color(0xFF00B4FF),
                                    modifier = Modifier.size(38.dp),
                                    strokeWidth = 2.5.dp
                                )
                                Spacer(Modifier.height(16.dp))
                                Text("Analyzing market data...", color = Color(0xFF94B0D0), fontSize = 14.sp)
                            }
                        }
                        return@Scaffold
                    }

                    if (mappedCandidates.isEmpty()) {
                        val formattedBudget = if (budget % 1.0 == 0.0) {
                            budget.toInt().toString()
                        } else {
                            String.format(java.util.Locale.US, "%.2f", budget).trimEnd('0').trimEnd('.')
                        }
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(padding)
                                .testTag("market_candidates_empty"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .widthIn(max = 480.dp)
                                    .clip(RoundedCornerShape(16.dp))
                                    .background(Color(0xE6081426))
                                    .border(1.dp, Color(0xFF18355A), RoundedCornerShape(16.dp))
                                    .padding(24.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                Icon(
                                    Icons.Default.SearchOff,
                                    contentDescription = null,
                                    tint = Color(0xFF00B4FF),
                                    modifier = Modifier.size(44.dp)
                                )
                                Spacer(Modifier.height(14.dp))
                                Text(
                                    text = "No Opportunities Within Your Budget",
                                    color = Color.White,
                                    fontSize = 18.sp,
                                    fontWeight = FontWeight.Bold,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.padding(horizontal = 16.dp)
                                )
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    text = "There are currently no eligible trading opportunities available within your $formattedBudget USDT trade budget. Please increase your budget and try again.",
                                    color = Color(0xFF94B0D0),
                                    fontSize = 14.sp,
                                    lineHeight = 20.sp,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.padding(horizontal = 16.dp)
                                )
                                Spacer(Modifier.height(20.dp))
                                GradientButton(
                                    text = "Increase Budget",
                                    onClick = { onIncreaseBudget?.invoke() ?: onBack?.invoke() },
                                    leadingIcon = Icons.Default.Tune,
                                    modifier = Modifier.fillMaxWidth(0.75f).widthIn(max = 280.dp),
                                    testTag = "market_candidates_increase_budget"
                                )
                            }
                        }
                        return@Scaffold
                    }
                }
            }

            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.TopCenter
            ) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxWidth()
                        .widthIn(max = 680.dp)
                        .padding(horizontal = 16.dp)
                        .testTag("market_candidates_list"),
                    verticalArrangement = Arrangement.spacedBy(0.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {

                    // Header block
                    item {
                        Spacer(Modifier.height(12.dp))
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            // Sparkle badge + Title
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.Center,
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(32.dp)
                                        .background(
                                            Brush.radialGradient(
                                                listOf(Color(0xFF9945FF), Color(0xFF4C1D95))
                                            ),
                                            CircleShape
                                        ),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(
                                        Icons.Default.AutoAwesome,
                                        contentDescription = null,
                                        tint = Color.White,
                                        modifier = Modifier.size(18.dp)
                                    )
                                }
                                Spacer(Modifier.width(10.dp))
                                Text(
                                    text = "TOP 10 MARKET OPPORTUNITIES",
                                    color = Color(0xFF00B4FF),
                                    fontWeight = FontWeight.ExtraBold,
                                    fontSize = 22.sp,
                                    letterSpacing = 0.4.sp,
                                    textAlign = TextAlign.Center
                                )
                            }
                        }

                        Spacer(Modifier.height(16.dp))

                        // Change API Keys Button
                        if (onChangeApiKeys != null) {
                            ChangeApiKeysPillButton(
                                onClick = onChangeApiKeys,
                                testTag = "change_api_keys_button"
                            )
                            Spacer(Modifier.height(18.dp))
                        }
                    }

                    // Metadata Card: DATE | LAST UPDATED
                    item {
                        val authTime = mappedCandidates.firstOrNull()?.exchangeTimestamp?.takeIf { it > 0L }
                        val displayTime = authTime?.let { java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date(it)) } ?: currentTime
                        MarketCandidatesMetadataCard(
                            currentDate = getCurrentDate(),
                            displayTime = displayTime,
                        )
                        Spacer(Modifier.height(14.dp))
                    }

                    // Candidate Cards
                    itemsIndexed(
                        items = mappedCandidates,
                        key = { _, candidate ->
                            candidate.opportunityId?.takeIf { it.isNotBlank() }
                                ?: "${candidate.pairName.ifEmpty { candidate.symbol }}:${candidate.tradeSide}:${candidate.rank}"
                        }
                    ) { _, candidate ->
                        android.util.Log.d("MarketCandidatesScreen", "[DIAGNOSTIC] Rendering item: symbol=${candidate.symbol}, pair=${candidate.pairName}, rank=${candidate.rank}, price=$${candidate.currentMarketPrice}")
                        CandidateRow(candidate = candidate, onClick = null)
                    }

                    // Prominent Red Information Card: How Opportunities Are Detected
                    item {
                        Spacer(Modifier.height(18.dp))
                        MarketOpportunitiesExplanationCard()
                        Spacer(Modifier.height(88.dp))
                    }
                }
            }
        }
    }
}

/**
 * Top bar matching the reference: Back Arrow on left, Brand Lockup in center, Refresh & Logout on right.
 */
@Composable
private fun MarketCandidatesTopBar(
    onBack: (() -> Unit)?,
    onRefresh: () -> Unit,
    isRefreshing: Boolean,
    onLogout: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .height(52.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        if (onBack != null) {
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
        } else {
            Spacer(Modifier.width(40.dp))
        }

        MarketCandidatesHeaderLockup()

        Row(
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(
                onClick = onRefresh,
                enabled = !isRefreshing,
                modifier = Modifier.size(40.dp)
            ) {
                if (isRefreshing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = Color(0xFF00B4FF)
                    )
                } else {
                    Icon(
                        imageVector = Icons.Default.Refresh,
                        contentDescription = "Refresh",
                        tint = Color(0xFF00B4FF),
                        modifier = Modifier.size(22.dp)
                    )
                }
            }

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
}

/**
 * Centered Master CryptoPulse Branding Lockup.
 */
@Composable
private fun MarketCandidatesHeaderLockup() {
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
 * "CHANGE API KEYS" Pill Action Button.
 */
@Composable
private fun ChangeApiKeysPillButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    testTag: String? = null,
) {
    val buttonRadius = 24.dp
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
        shape = RoundedCornerShape(buttonRadius),
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.Transparent,
            disabledContainerColor = Color.Transparent,
        ),
        contentPadding = PaddingValues(0.dp),
        modifier = modifier
            .widthIn(min = 260.dp)
            .height(48.dp)
            .drawBehind {
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
            .then(if (testTag != null) Modifier.testTag(testTag) else Modifier),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(buttonGradient, RoundedCornerShape(buttonRadius)),
            contentAlignment = Alignment.Center,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
                modifier = Modifier.padding(horizontal = 24.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.VpnKey,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "CHANGE API KEYS",
                    color = Color.White,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 14.5.sp,
                    letterSpacing = 1.2.sp,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/**
 * Metadata Card for DATE and LAST UPDATED.
 */
@Composable
private fun MarketCandidatesMetadataCard(
    currentDate: String,
    displayTime: String,
    modifier: Modifier = Modifier,
) {
    val cardRadius = 16.dp
    val borderBrush = Brush.verticalGradient(
        listOf(
            Color(0xFF00B4FF),
            Color(0xFF0077E6),
            Color(0xFF0044AA),
        )
    )

    Box(
        modifier = modifier
            .fillMaxWidth()
            .drawBehind {
                drawRoundRect(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color(0x2800B4FF),
                            Color(0x100066FF),
                            Color.Transparent
                        ),
                        center = Offset(size.width / 2f, size.height / 2f),
                        radius = size.width * 0.65f
                    ),
                    cornerRadius = CornerRadius(cardRadius.toPx() + 4.dp.toPx(), cardRadius.toPx() + 4.dp.toPx())
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
                width = 1.3.dp,
                brush = borderBrush,
                shape = RoundedCornerShape(cardRadius)
            )
            .padding(vertical = 14.dp, horizontal = 16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Left: DATE
            Column(
                modifier = Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Default.CalendarToday,
                        contentDescription = null,
                        tint = Color(0xFF00B4FF),
                        modifier = Modifier.size(15.dp)
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = "DATE",
                        color = Color(0xFF7E9DBF),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 1.sp
                    )
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    text = currentDate,
                    color = Color.White,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold
                )
            }

            // Divider
            Box(
                modifier = Modifier
                    .width(1.dp)
                    .height(34.dp)
                    .background(Color(0xFF18355A))
            )

            // Right: LAST UPDATED
            Column(
                modifier = Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Default.Schedule,
                        contentDescription = null,
                        tint = Color(0xFF00B4FF),
                        modifier = Modifier.size(15.dp)
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = "LAST UPDATED",
                        color = Color(0xFF7E9DBF),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 1.sp
                    )
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    text = displayTime,
                    color = Color.White,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}

/**
 * Prominent red-highlighted information card explaining how market opportunities are detected.
 * Reflects verified Bybit 400+ linear perpetual ticker scanning, liquidity/volume filtering,
 * multi-timeframe analysis, and Opportunity Score ranking.
 */
@Composable
private fun MarketOpportunitiesExplanationCard(
    modifier: Modifier = Modifier,
) {
    val cardRadius = 16.dp
    val redBorderBrush = Brush.verticalGradient(
        listOf(
            Color(0xFFFF3355),
            Color(0xFFCC1133),
            Color(0xFF800A1A),
        )
    )

    Box(
        modifier = modifier
            .fillMaxWidth()
            .drawBehind {
                drawRoundRect(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color(0x30FF1E40),
                            Color(0x10CC0025),
                            Color.Transparent
                        ),
                        center = Offset(size.width / 2f, size.height / 2f),
                        radius = size.width * 0.65f
                    ),
                    cornerRadius = CornerRadius(cardRadius.toPx() + 4.dp.toPx(), cardRadius.toPx() + 4.dp.toPx())
                )
            }
            .clip(RoundedCornerShape(cardRadius))
            .background(
                Brush.verticalGradient(
                    listOf(
                        Color(0xF018080C),
                        Color(0xF50F0306)
                    )
                )
            )
            .border(
                width = 1.3.dp,
                brush = redBorderBrush,
                shape = RoundedCornerShape(cardRadius)
            )
            .padding(vertical = 16.dp, horizontal = 18.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxWidth()
        ) {
            // Header: Red glowing icon badge + Title
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .background(
                            Brush.radialGradient(
                                listOf(Color(0x50FF3355), Color(0x15FF1E40))
                            ),
                            CircleShape
                        )
                        .border(1.dp, Color(0x99FF3355), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Default.Info,
                        contentDescription = null,
                        tint = Color(0xFFFF3355),
                        modifier = Modifier.size(16.dp)
                    )
                }

                Spacer(Modifier.width(10.dp))

                Text(
                    text = "HOW THESE OPPORTUNITIES ARE DETECTED",
                    color = Color(0xFFFF3355),
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 13.5.sp,
                    letterSpacing = 1.sp,
                    style = TextStyle(
                        shadow = Shadow(
                            color = Color(0x80FF3355),
                            offset = Offset(0f, 0f),
                            blurRadius = 8f
                        )
                    )
                )
            }

            Spacer(Modifier.height(12.dp))

            // Body with visual highlighting on factual elements
            val explanationText = remember {
                buildAnnotatedString {
                    append("CryptoPulse continuously scans ")
                    withStyle(SpanStyle(color = Color.White, fontWeight = FontWeight.Bold)) {
                        append("400+ eligible USDT perpetual tickers")
                    }
                    append(" on ")
                    withStyle(SpanStyle(color = Color.White, fontWeight = FontWeight.Bold)) {
                        append("Bybit")
                    }
                    append(". It filters the market using the existing liquidity, volume, spread and market-quality criteria, evaluates the remaining candidates across ")
                    withStyle(SpanStyle(color = Color.White, fontWeight = FontWeight.Bold)) {
                        append("multiple timeframes")
                    }
                    append(" and technical conditions, and ranks them by the existing ")
                    withStyle(SpanStyle(color = Color(0xFFFF526C), fontWeight = FontWeight.Bold)) {
                        append("Opportunity Score")
                    }
                    append(". The ")
                    withStyle(SpanStyle(color = Color.White, fontWeight = FontWeight.Bold)) {
                        append("Top 10")
                    }
                    append(" Market Opportunities shown above are the highest-ranked candidates from this scan.")
                }
            }

            Text(
                text = explanationText,
                color = Color(0xFFB4C6DC),
                fontSize = 12.5.sp,
                lineHeight = 19.sp,
                letterSpacing = 0.2.sp,
            )
        }
    }
}

/**
 * Candidate card row matching reference: Coin Logo + Coin Name + Symbol/USDT | QUANTITY | MIN QTY | SCORE.
 */
@Composable
private fun CandidateRow(candidate: MarketCandidate, onClick: (() -> Unit)? = null) {
    val accessibleDescription = candidate.toAccessibilityDescription()
    val cardRadius = 16.dp
    val borderBrush = Brush.verticalGradient(
        listOf(
            Color(0xFF00B4FF),
            Color(0xFF0077E6),
            Color(0xFF0044AA),
        )
    )

    val formattedPrice = if (candidate.formattedPrice.isNotBlank())
        "\$${candidate.formattedPrice}"
    else
        "\$${Formatters.formatCryptoPrice(candidate.currentMarketPrice)}"

    val minQtyStr = candidate.minOrderQty?.let { Formatters.formatConstraint(it) } ?: "0.1"
    val scoreStr = Formatters.formatScore(candidate.score)
    val coinDisplayName = getCoinDisplayName(candidate.symbol, candidate.coinName)

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp)
            .drawBehind {
                drawRoundRect(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color(0x2400B4FF),
                            Color(0x0C0066FF),
                            Color.Transparent
                        ),
                        center = Offset(size.width / 2f, size.height / 2f),
                        radius = size.width * 0.65f
                    ),
                    cornerRadius = CornerRadius(cardRadius.toPx() + 4.dp.toPx(), cardRadius.toPx() + 4.dp.toPx())
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
                width = 1.3.dp,
                brush = borderBrush,
                shape = RoundedCornerShape(cardRadius)
            )
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .testTag("candidate_item")
            .semantics(mergeDescendants = true) {
                contentDescription = accessibleDescription
            }
            .padding(horizontal = 14.dp, vertical = 13.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 1. Coin Avatar + Coin Name underneath + Symbol & /USDT
            Row(
                modifier = Modifier.weight(1.35f),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    CandidateCoinAvatar(candidate = candidate)
                    Spacer(Modifier.height(3.dp))
                    Text(
                        text = coinDisplayName,
                        color = Color(0xFF7E9DBF),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                Spacer(Modifier.width(10.dp))

                Column {
                    Text(
                        text = candidate.symbol,
                        color = Color.White,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 16.sp,
                        letterSpacing = 0.2.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = if (candidate.pairName.contains("/"))
                            "/${candidate.pairName.split("/").getOrElse(1) { "USDT" }}"
                        else "/USDT",
                        color = Color(0xFF7E9DBF),
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1
                    )
                }
            }

            // 2. Metrics Section: QUANTITY | MIN QTY | SCORE
            Row(
                modifier = Modifier.weight(1.95f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                // QUANTITY (Price)
                Column(
                    modifier = Modifier.weight(1f),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "QUANTITY",
                        color = Color(0xFF7E9DBF),
                        fontSize = 9.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 0.4.sp,
                        maxLines = 1
                    )
                    Spacer(Modifier.height(3.dp))
                    Text(
                        text = formattedPrice,
                        color = Color.White,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 14.5.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                // Vertical Divider
                Box(
                    modifier = Modifier
                        .width(1.dp)
                        .height(28.dp)
                        .background(Color(0xFF18355A))
                )

                // MIN QTY
                Column(
                    modifier = Modifier.weight(0.85f),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "MIN QTY",
                        color = Color(0xFF7E9DBF),
                        fontSize = 9.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 0.4.sp,
                        maxLines = 1
                    )
                    Spacer(Modifier.height(3.dp))
                    Text(
                        text = minQtyStr,
                        color = Color.White,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 14.5.sp,
                        maxLines = 1
                    )
                }

                // Vertical Divider
                Box(
                    modifier = Modifier
                        .width(1.dp)
                        .height(28.dp)
                        .background(Color(0xFF18355A))
                )

                // SCORE
                Column(
                    modifier = Modifier.weight(0.85f),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        text = "SCORE",
                        color = Color(0xFF7E9DBF),
                        fontSize = 9.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 0.4.sp,
                        maxLines = 1
                    )
                    Spacer(Modifier.height(3.dp))
                    Text(
                        text = scoreStr,
                        color = Color(0xFF00B4FF),
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 14.5.sp,
                        maxLines = 1
                    )
                }
            }
        }
    }
}

/**
 * Coin Avatar rendering matching the reference screenshot icons.
 */
@Composable
private fun CandidateCoinAvatar(candidate: MarketCandidate) {
    val sym = candidate.symbol.uppercase()
    val size = 38.dp
    when {
        sym.contains("SOL") || sym.contains("SOPH") -> SolanaCoinIcon(size)
        sym.contains("BNB") || sym.contains("BNC") -> BnbCoinIcon(size)
        sym.contains("WAV") -> WavesCoinIcon(size)
        sym.contains("AERO") -> AerodromeCoinIcon(size)
        sym.contains("USE") || sym.contains("USUAL") -> UsualCoinIcon(size)
        sym.contains("UAI") -> UaiCoinIcon(size)
        sym.contains("BTC") -> BitcoinCoinIcon(size)
        sym.contains("ETH") -> EthereumCoinIcon(size)
        else -> GenericCoinAvatar(candidate, size)
    }
}

/**
 * Solana Coin Icon: purple/indigo circular background with 3 stepped horizontal white bars.
 */
@Composable
private fun SolanaCoinIcon(size: androidx.compose.ui.unit.Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(
                Brush.linearGradient(
                    listOf(Color(0xFF6366F1), Color(0xFF7C3AED), Color(0xFF4C1D95))
                )
            ),
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.size(size * 0.58f)) {
            val w = this.size.width
            val h = this.size.height
            val barH = h * 0.18f
            val rad = barH / 2f

            // Top bar
            drawRoundRect(
                color = Color.White,
                topLeft = Offset(0f, 0f),
                size = Size(w * 0.85f, barH),
                cornerRadius = CornerRadius(rad, rad)
            )
            // Middle bar
            drawRoundRect(
                color = Color.White,
                topLeft = Offset(w * 0.15f, (h - barH) / 2f),
                size = Size(w * 0.85f, barH),
                cornerRadius = CornerRadius(rad, rad)
            )
            // Bottom bar
            drawRoundRect(
                color = Color.White,
                topLeft = Offset(0f, h - barH),
                size = Size(w * 0.85f, barH),
                cornerRadius = CornerRadius(rad, rad)
            )
        }
    }
}

/**
 * BNB Coin Icon: golden yellow circle with nested diamonds.
 */
@Composable
private fun BnbCoinIcon(size: androidx.compose.ui.unit.Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(Color(0xFFF3BA2F)),
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.size(size * 0.55f)) {
            val w = this.size.width
            val h = this.size.height
            val cx = w / 2f
            val cy = h / 2f
            val r = w * 0.22f

            fun DrawScope.drawRotatedDiamond(center: Offset, radius: Float) {
                val path = Path().apply {
                    moveTo(center.x, center.y - radius)
                    lineTo(center.x + radius, center.y)
                    lineTo(center.x, center.y + radius)
                    lineTo(center.x - radius, center.y)
                    close()
                }
                drawPath(path, Color.White)
            }

            drawRotatedDiamond(Offset(cx, cy), r)
            drawRotatedDiamond(Offset(cx, cy - r * 1.5f), r * 0.5f)
            drawRotatedDiamond(Offset(cx, cy + r * 1.5f), r * 0.5f)
            drawRotatedDiamond(Offset(cx - r * 1.5f, cy), r * 0.5f)
            drawRotatedDiamond(Offset(cx + r * 1.5f, cy), r * 0.5f)
        }
    }
}

/**
 * Waves Coin Icon: vibrant teal circle with wave lines.
 */
@Composable
private fun WavesCoinIcon(size: androidx.compose.ui.unit.Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(Color(0xFF00BFA5)),
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.size(size * 0.55f)) {
            val w = this.size.width
            val h = this.size.height
            val strokeW = 2.4.dp.toPx()

            fun DrawScope.drawWave(y: Float) {
                val path = Path().apply {
                    moveTo(0f, y)
                    cubicTo(w * 0.25f, y - 3.5.dp.toPx(), w * 0.25f, y + 3.5.dp.toPx(), w * 0.5f, y)
                    cubicTo(w * 0.75f, y - 3.5.dp.toPx(), w * 0.75f, y + 3.5.dp.toPx(), w, y)
                }
                drawPath(path, Color.White, style = androidx.compose.ui.graphics.drawscope.Stroke(width = strokeW))
            }

            drawWave(h * 0.25f)
            drawWave(h * 0.50f)
            drawWave(h * 0.75f)
        }
    }
}

/**
 * Aerodrome Coin Icon: dark slate circle with delta / A symbol.
 */
@Composable
private fun AerodromeCoinIcon(size: androidx.compose.ui.unit.Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(Color(0xFF1E293B))
            .border(1.2.dp, Color(0xFF475569), CircleShape),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = "A",
            color = Color.White,
            fontWeight = FontWeight.Black,
            fontSize = 18.sp
        )
    }
}

/**
 * Usual Coin Icon: electric blue circle with white U symbol.
 */
@Composable
private fun UsualCoinIcon(size: androidx.compose.ui.unit.Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(Color(0xFF0077FF)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = "U",
            color = Color.White,
            fontWeight = FontWeight.Black,
            fontSize = 18.sp
        )
    }
}

/**
 * UAI Coin Icon: indigo/purple gradient circle with teardrop/flame.
 */
@Composable
private fun UaiCoinIcon(size: androidx.compose.ui.unit.Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(
                Brush.radialGradient(
                    listOf(Color(0xFF6366F1), Color(0xFF4338CA))
                )
            ),
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.size(size * 0.50f)) {
            val w = this.size.width
            val h = this.size.height
            val path = Path().apply {
                moveTo(w / 2f, 0f)
                cubicTo(w, h * 0.45f, w, h, w / 2f, h)
                cubicTo(0f, h, 0f, h * 0.45f, w / 2f, 0f)
                close()
            }
            drawPath(path, Color.White)
        }
    }
}

/**
 * Bitcoin Coin Icon: Orange circle with ₿ symbol.
 */
@Composable
private fun BitcoinCoinIcon(size: androidx.compose.ui.unit.Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(Color(0xFFF7931A)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = "₿",
            color = Color.White,
            fontWeight = FontWeight.Bold,
            fontSize = 19.sp
        )
    }
}

/**
 * Ethereum Coin Icon: Navy/purple circle with diamond.
 */
@Composable
private fun EthereumCoinIcon(size: androidx.compose.ui.unit.Dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(Color(0xFF627EEA)),
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.size(size * 0.50f)) {
            val w = this.size.width
            val h = this.size.height
            val path = Path().apply {
                moveTo(w / 2f, 0f)
                lineTo(w, h * 0.45f)
                lineTo(w / 2f, h)
                lineTo(0f, h * 0.45f)
                close()
            }
            drawPath(path, Color.White)
        }
    }
}

/**
 * Dynamic coin avatar for any token without explicit icon.
 */
@Composable
private fun GenericCoinAvatar(candidate: MarketCandidate, size: androidx.compose.ui.unit.Dp) {
    val color = if (candidate.coinColor != Color.Unspecified) candidate.coinColor else getDeterministicCoinColor(candidate.symbol)
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(
                Brush.radialGradient(
                    listOf(color.copy(alpha = 0.45f), color.copy(alpha = 0.15f))
                )
            )
            .border(1.2.dp, color.copy(alpha = 0.7f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = candidate.symbol.take(3),
            color = Color.White,
            fontWeight = FontWeight.ExtraBold,
            fontSize = 11.sp,
            maxLines = 1,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * Deterministic color picker based on symbol string hash.
 */
private fun getDeterministicCoinColor(symbol: String): Color {
    val colors = listOf(
        Color(0xFF00B4FF),
        Color(0xFF38BDF8),
        Color(0xFF818CF8),
        Color(0xFFA78BFA),
        Color(0xFFF472B6),
        Color(0xFF34D399),
        Color(0xFFFBBF24),
        Color(0xFFFB923C),
    )
    val hash = symbol.hashCode()
    val index = kotlin.math.abs(hash) % colors.size
    return colors[index]
}

/**
 * Full coin display name lookup matching the reference.
 */
private fun getCoinDisplayName(symbol: String, coinName: String): String {
    val upper = symbol.uppercase()
    return when {
        upper.contains("SOL") || upper.contains("SOPH") -> "Solana"
        upper.contains("BNB") || upper.contains("BNC") -> "BNB"
        upper.contains("WAV") -> "Waves"
        upper.contains("AERO") -> "Aerodrome"
        upper.contains("USE") || upper.contains("USUAL") -> "Usual"
        upper.contains("UAI") -> "UAI"
        upper.contains("BTC") -> "Bitcoin"
        upper.contains("ETH") -> "Ethereum"
        upper.contains("XRP") -> "XRP"
        upper.contains("DOGE") -> "Dogecoin"
        upper.contains("ADA") -> "Cardano"
        upper.contains("AVAX") -> "Avalanche"
        upper.contains("DOT") -> "Polkadot"
        upper.contains("LINK") -> "Chainlink"
        upper.contains("MATIC") || upper.contains("POL") -> "Polygon"
        upper.contains("NEAR") -> "NEAR"
        upper.contains("APT") -> "Aptos"
        upper.contains("SUI") -> "Sui"
        upper.contains("PEPE") -> "Pepe"
        upper.contains("SHIB") -> "Shiba Inu"
        upper.contains("RENDER") -> "Render"
        upper.contains("TAO") -> "Bittensor"
        upper.contains("FET") -> "ASI"
        upper.contains("INJ") -> "Injective"
        upper.contains("TIA") -> "Celestia"
        upper.contains("SEI") -> "Sei"
        upper.contains("KAS") -> "Kaspa"
        upper.contains("TON") -> "Toncoin"
        upper.contains("TRX") -> "TRON"
        coinName.isNotBlank() && coinName != symbol -> coinName
        else -> symbol
    }
}

/**
 * Ambient bottom horizon reflection flare on the floor of the screen.
 */
@Composable
private fun MarketCandidatesBottomHorizonGlow(
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
private fun getCurrentTime(): String =
    SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())

private fun getCurrentDate(): String =
    SimpleDateFormat("d MMM yyyy", Locale.getDefault()).format(Date())

