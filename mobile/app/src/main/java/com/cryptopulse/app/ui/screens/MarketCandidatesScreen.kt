package com.cryptopulse.app.ui.screens

import com.cryptopulse.app.core.network.*

import androidx.activity.ComponentActivity
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
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
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
    val exchangeTimestamp: Long = 0L
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
    onBack: (() -> Unit)? = null,
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
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))
    val listState = rememberLazyListState()

    var currentTime by remember { mutableStateOf(getCurrentTime()) }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(60_000)
            currentTime = getCurrentTime()
        }
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

                when (val state = marketDataState) {
                    is com.cryptopulse.app.ui.auth.MarketDataUiState.Error -> {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(padding)
                                .testTag("market_candidates_error"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Icon(
                                    Icons.Default.WifiOff,
                                    contentDescription = null,
                                    tint = LossRed,
                                    modifier = Modifier.size(40.dp)
                                )
                                Spacer(Modifier.height(12.dp))
                                Text(
                                    state.message,
                                    color = TextSecondary,
                                    fontSize = 14.sp,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.padding(horizontal = 32.dp)
                                )
                                state.hint?.let { hint ->
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        hint,
                                        color = TextSecondary.copy(alpha = 0.7f),
                                        fontSize = 12.sp,
                                        textAlign = TextAlign.Center,
                                        modifier = Modifier.padding(horizontal = 32.dp)
                                    )
                                }
                                Spacer(Modifier.height(16.dp))
                                GradientButton(
                                    text = "Retry",
                                    onClick = { viewModel.clearCandidatesError(); viewModel.fetchMarketCandidates() },
                                    leadingIcon = Icons.Default.Refresh,
                                    modifier = Modifier.fillMaxWidth(0.6f),
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
                                CircularProgressIndicator(color = CyanPrimary)
                                Spacer(Modifier.height(16.dp))
                                Text("Analyzing market data...", color = TextSecondary, fontSize = 14.sp)
                            }
                        }
                        return@Scaffold
                    }

                    is com.cryptopulse.app.ui.auth.MarketDataUiState.Empty -> {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(padding)
                                .testTag("market_candidates_empty"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Icon(
                                    Icons.Default.SearchOff,
                                    contentDescription = null,
                                    tint = TextSecondary,
                                    modifier = Modifier.size(40.dp)
                                )
                                Spacer(Modifier.height(12.dp))
                                Text(
                                    state.message,
                                    color = TextSecondary,
                                    fontSize = 14.sp,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.padding(horizontal = 32.dp)
                                )
                                Spacer(Modifier.height(16.dp))
                                GradientButton(
                                    text = "Rescan Market",
                                    onClick = { viewModel.fetchMarketCandidates() },
                                    leadingIcon = Icons.Default.Refresh,
                                    modifier = Modifier.fillMaxWidth(0.6f),
                                    testTag = "market_candidates_rescan"
                                )
                            }
                        }
                        return@Scaffold
                    }

                    else -> {
                        // Fallback to legacy safety checks if marketDataState is Idle
                        if (candidatesError != null) {
                            Box(
                                modifier = Modifier
                                    .fillMaxSize()
                                    .padding(padding)
                                    .testTag("market_candidates_error"),
                                contentAlignment = Alignment.Center,
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Icon(
                                        Icons.Default.WifiOff,
                                        contentDescription = null,
                                        tint = LossRed,
                                        modifier = Modifier.size(40.dp)
                                    )
                                    Spacer(Modifier.height(12.dp))
                                    Text(
                                        candidatesError ?: "Failed to load market candidates.",
                                        color = TextSecondary,
                                        fontSize = 14.sp,
                                        textAlign = TextAlign.Center,
                                        modifier = Modifier.padding(horizontal = 32.dp)
                                    )
                                    Spacer(Modifier.height(16.dp))
                                    GradientButton(
                                        text = "Retry",
                                        onClick = { viewModel.clearCandidatesError(); viewModel.fetchMarketCandidates() },
                                        leadingIcon = Icons.Default.Refresh,
                                        modifier = Modifier.fillMaxWidth(0.6f),
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
                                    CircularProgressIndicator(color = CyanPrimary)
                                    Spacer(Modifier.height(16.dp))
                                    Text("Analyzing market data...", color = TextSecondary, fontSize = 14.sp)
                                }
                            }
                            return@Scaffold
                        }

                        if (mappedCandidates.isEmpty()) {
                            Box(
                                modifier = Modifier
                                    .fillMaxSize()
                                    .padding(padding)
                                    .testTag("market_candidates_empty"),
                                contentAlignment = Alignment.Center,
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Icon(
                                        Icons.Default.SearchOff,
                                        contentDescription = null,
                                        tint = TextSecondary,
                                        modifier = Modifier.size(40.dp)
                                    )
                                    Spacer(Modifier.height(12.dp))
                                    Text(
                                        "No market candidates found matching criteria.",
                                        color = TextSecondary,
                                        fontSize = 14.sp,
                                        textAlign = TextAlign.Center,
                                        modifier = Modifier.padding(horizontal = 32.dp)
                                    )
                                    Spacer(Modifier.height(16.dp))
                                    GradientButton(
                                        text = "Rescan Market",
                                        onClick = { viewModel.fetchMarketCandidates() },
                                        leadingIcon = Icons.Default.Refresh,
                                        modifier = Modifier.fillMaxWidth(0.6f),
                                        testTag = "market_candidates_rescan"
                                    )
                                }
                            }
                            return@Scaffold
                        }
                    }
                }

            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 16.dp)
                    .testTag("market_candidates_list"),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {

                item {
                    Spacer(Modifier.height(16.dp))
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center,
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(30.dp)
                                    .background(
                                        Brush.radialGradient(
                                            listOf(Color(0xFF5B2D9E), Color(0xFF2A1060))
                                        ),
                                        CircleShape
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    Icons.Default.AutoAwesome,
                                    contentDescription = null,
                                    tint = Color(0xFFBB86FC),
                                    modifier = Modifier.size(16.dp)
                                )
                            }
                            Spacer(Modifier.width(10.dp))
                            Text(
                                text = "Today's Most Profitable Pairs",
                                color = TextPrimary,
                                fontWeight = FontWeight.ExtraBold,
                                fontSize = 20.sp,
                                letterSpacing = 0.3.sp,
                            )
                        }
                        Spacer(Modifier.height(5.dp))
                        Text(
                            text = "Ranked by the CryptoPulse Technical Screening Algorithm",
                            color = CyanPrimary.copy(alpha = 0.75f),
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Medium,
                            letterSpacing = 0.2.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Spacer(Modifier.height(16.dp))
                }

                item {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(NavyCard, RoundedCornerShape(10.dp))
                            .border(1.dp, NavyBorder, RoundedCornerShape(10.dp))
                            .padding(vertical = 10.dp, horizontal = 12.dp),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                    ) {
                        val authTime = mappedCandidates.firstOrNull()?.exchangeTimestamp?.takeIf { it > 0L }
                        val displayTime = authTime?.let { java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date(it)) } ?: currentTime
                        MetadataItem(icon = Icons.Default.CalendarToday, label = "DATE", value = getCurrentDate())
                        VerticalDivider()
                        MetadataItem(icon = Icons.Default.Schedule, label = "LAST UPDATED", value = displayTime)
                    }
                    Spacer(Modifier.height(14.dp))
                }

                item {
                    Divider(color = NavyBorder, thickness = 1.dp, modifier = Modifier.padding(vertical = 4.dp))
                }

                itemsIndexed(mappedCandidates, key = { _, candidate -> candidate.pairName.ifEmpty { candidate.symbol } }) { _, candidate ->
                    android.util.Log.d("MarketCandidatesScreen", "[DIAGNOSTIC] Rendering item: symbol=${candidate.symbol}, pair=${candidate.pairName}, rank=${candidate.rank}, price=$${candidate.currentMarketPrice}")
                    CandidateRow(candidate = candidate, onClick = {
                        viewModel.selectCandidate(candidate)
                        onCandidateClick(candidate)
                    })
                }

                item {
                    Spacer(Modifier.height(12.dp))
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0x1400B4FF), RoundedCornerShape(10.dp))
                            .border(1.dp, CyanPrimary.copy(alpha = 0.2f), RoundedCornerShape(10.dp))
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Default.Info, null, tint = CyanPrimary, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = "These candidates are selected based on multi-layer technical analysis, volume, volatility, momentum and breakout potential.",
                            color = TextSecondary,
                            fontSize = 11.sp,
                            lineHeight = 17.sp,
                        )
                    }
                    Spacer(Modifier.height(20.dp))
                }
            }
        }
    }
}

// ─── Single candidate card ────────────────────────────────────────────────────
@Composable
private fun CandidateRow(candidate: MarketCandidate, onClick: () -> Unit) {
    val accessibleDescription = candidate.toAccessibilityDescription()

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(
                Brush.verticalGradient(
                    listOf(
                        Color(0xFF0D1B2E),
                        Color(0xFF091525),
                    )
                )
            )
            .border(
                width = 1.dp,
                brush = Brush.linearGradient(
                    listOf(
                        NavyBorder.copy(alpha = 0.7f),
                        NavyBorder.copy(alpha = 0.2f),
                    )
                ),
                shape = RoundedCornerShape(14.dp)
            )
            .clickable(onClick = onClick)
            .testTag("candidate_item")
            .semantics(mergeDescendants = true) {
                contentDescription = accessibleDescription
            }
    ) {

        // ── PRIMARY SECTION: 4 structured columns with strict weights ──
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 1. Ticker (Avatar + Pair Symbol)
            Row(
                modifier = Modifier.weight(1.35f),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .background(candidate.coinColor.copy(alpha = 0.15f), CircleShape)
                        .border(1.5.dp, candidate.coinColor.copy(alpha = 0.5f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = candidate.symbol.take(4),
                        color = candidate.coinColor,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 10.sp,
                        textAlign = TextAlign.Center,
                    )
                }
                Spacer(Modifier.width(8.dp))
                Column {
                    Text(
                        text = candidate.symbol,
                        color = TextPrimary,
                        fontWeight = FontWeight.ExtraBold,
                        fontSize = 14.sp,
                        letterSpacing = 0.2.sp,
                    )
                    Text(
                        text = if (candidate.pairName.contains("/"))
                            "/${candidate.pairName.split("/").getOrElse(1) { "USDT" }}"
                        else "/USDT",
                        color = TextMuted,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }

            // 2. Live Market Price (USDT)
            Column(
                modifier = Modifier.weight(1.1f),
                horizontalAlignment = Alignment.Start
            ) {
                Text(
                    text = "PRICE (USDT)",
                    color = TextMuted,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.5.sp,
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    text = if (candidate.formattedPrice.isNotBlank())
                        "\$${candidate.formattedPrice}"
                    else
                        "\$${Formatters.formatCryptoPrice(candidate.currentMarketPrice)}",
                    color = TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp,
                    style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                )
            }

            // 3. Technical Score
            Column(
                modifier = Modifier.weight(0.85f),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "SCORE",
                    color = TextMuted,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.5.sp,
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    text = Formatters.formatScore(candidate.score),
                    color = CyanPrimary,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.ExtraBold,
                    style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                )
            }

            // 4. Trading Constraints
            Column(
                modifier = Modifier.weight(1.1f),
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.Center
            ) {
                Text(
                    text = "Min Qty: ${Formatters.formatConstraint(candidate.minOrderQty ?: 0.0)}",
                    color = TextSecondary,
                    fontSize = 10.sp,
                    style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                )
                Text(
                    text = "Qty Step: ${Formatters.formatConstraint(candidate.qtyStep ?: 0.0)}",
                    color = TextSecondary,
                    fontSize = 10.sp,
                    style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                )
                Text(
                    text = "Tick Size: ${Formatters.formatConstraint(candidate.tickSize ?: 0.0)}",
                    color = TextSecondary,
                    fontSize = 10.sp,
                    style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
                )
            }
        }
    }
}

// ─── Secondary stat label + value block ─────────────────────────────────────
@Composable
private fun SecondaryStatItem(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    valueColor: Color = TextSecondary,
    horizontalAlignment: Alignment.Horizontal = Alignment.CenterHorizontally,
) {
    Column(
        modifier = modifier,
        horizontalAlignment = horizontalAlignment
    ) {
        Text(
            text = label.uppercase(),
            color = TextMuted,
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.4.sp,
        )
        Spacer(Modifier.height(3.dp))
        Text(
            text = value,
            color = valueColor,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum")
        )
    }
}

// ─── Rank badge (gold/silver/bronze/plain) ────────────────────────────────────
@Composable
private fun RankBadge(rank: Int) {
    val (bg, text) = when (rank) {
        1 -> Color(0xFFF59E0B) to Color(0xFF1A0F00)
        2 -> Color(0xFF94A8B8) to Color(0xFF0A0F1A)
        3 -> Color(0xFFCD7F32) to Color(0xFF1A0A00)
        else -> NavyMid to TextSecondary
    }
    Box(
        modifier = Modifier
            .size(28.dp)
            .background(bg, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = rank.toString(),
            color = text,
            fontWeight = FontWeight.ExtraBold,
            fontSize = 12.sp,
        )
    }
}

// ─── Metadata item helper ─────────────────────────────────────────────────────
@Composable
private fun MetadataItem(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = CyanPrimary, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(3.dp))
            Text(label, color = TextMuted, fontSize = 8.sp, letterSpacing = 0.5.sp)
        }
        Text(value, color = TextPrimary, fontWeight = FontWeight.SemiBold, fontSize = 11.sp)
    }
}

@Composable
private fun VerticalDivider() {
    Box(
        Modifier
            .width(1.dp)
            .height(32.dp)
            .background(NavyBorder)
    )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
private fun getCurrentTime(): String =
    SimpleDateFormat("hh:mm:ss a", Locale.getDefault()).format(Date())

private fun getCurrentDate(): String =
    SimpleDateFormat("d MMM yyyy", Locale.getDefault()).format(Date())
