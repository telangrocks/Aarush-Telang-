package com.cryptopulse.app.ui.screens

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.data.api.MarketCandidateDto
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.theme.*
import java.text.SimpleDateFormat
import java.util.*

// ─── Data model for the screen ────────────────────────────────────────────────
data class MarketCandidate(
    val rank: Int = 0,
    val symbol: String = "",
    val pairName: String = "",
    val coinName: String = "",
    val notations: Int = 0,
    val currentMarketPrice: Double = 0.0,
    val minNotional: Double = 0.0,
    val coinColor: Color = Color.Unspecified,
    val volume24h: Double = 0.0,
    val quoteVolume24h: Double = 0.0,
    val priceChangePercent24h: Double = 0.0,
    val score: Double = 0.0,
)

// ─────────────────────────────────────────────────────────────────────────────
// Market Candidates Screen
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun MarketCandidatesScreen(
    onCandidateClick: (MarketCandidate) -> Unit,
    onBack: (() -> Unit)? = null,
    viewModel: com.cryptopulse.app.ui.auth.ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
) {
    val candidates by viewModel.candidates.collectAsState(initial = emptyList())
    val candidatesError by viewModel.candidatesError.collectAsState(initial = null)
    val mappedCandidates = remember(candidates) { candidates.toScreenCandidates() }
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

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

                if (mappedCandidates.isEmpty()) {
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

            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 16.dp)
                    .testTag("market_candidates_list"),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {

                item {
                    Spacer(Modifier.height(12.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(32.dp)
                                .background(Color(0xFF3B1F6E), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Default.AutoAwesome, null, tint = Color(0xFFBB86FC), modifier = Modifier.size(18.dp))
                        }
                        Spacer(Modifier.width(10.dp))
                        Text(
                            text = "TOP 10 SHORTLISTED\nCANDIDATES",
                            color = CyanPrimary,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 18.sp,
                            letterSpacing = 1.2.sp,
                            lineHeight = 24.sp,
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = "Best intraday trading opportunities identified by AI",
                        color = TextSecondary,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(14.dp))
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
                        MetadataItem(icon = Icons.Default.Schedule, label = "UPDATED AT", value = currentTime)
                        VerticalDivider()
                        MetadataItem(icon = Icons.Default.CalendarToday, label = "DATE", value = getCurrentDate())
                        VerticalDivider()
                        MetadataItem(icon = Icons.Default.Refresh, label = "AUTO UPDATED", value = "Every 60 sec")
                    }
                    Spacer(Modifier.height(14.dp))
                }

                item {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("#", color = TextMuted, fontSize = 11.sp, letterSpacing = 0.5.sp, modifier = Modifier.width(28.dp))
                        Text("COIN / PAIR", color = TextMuted, fontSize = 11.sp, letterSpacing = 0.5.sp, modifier = Modifier.weight(1f))
                        Text("MIN. NOTATIONS", color = TextMuted, fontSize = 11.sp, letterSpacing = 0.5.sp, textAlign = TextAlign.End)
                    }
                    Divider(color = NavyBorder, thickness = 1.dp, modifier = Modifier.padding(vertical = 4.dp))
                }

                itemsIndexed(mappedCandidates) { _, candidate ->
                    CandidateRow(candidate = candidate, onClick = {
                        viewModel.selectCandidate(candidate)
                        onCandidateClick(candidate)
                    })
                    Divider(color = NavyBorder.copy(alpha = 0.5f), thickness = 0.5.dp)
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
                            text = "These candidates are selected based on multi-layer AI analysis, volume, volatility, momentum and breakout potential.",
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

// ─── Single candidate row ─────────────────────────────────────────────────────
@Composable
private fun CandidateRow(candidate: MarketCandidate, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .testTag("candidate_item")
            .padding(vertical = 12.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RankBadge(rank = candidate.rank)

        Spacer(Modifier.width(10.dp))

        Box(
            modifier = Modifier
                .size(38.dp)
                .background(candidate.coinColor.copy(alpha = 0.18f), CircleShape)
                .border(1.5.dp, candidate.coinColor.copy(alpha = 0.5f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = candidate.symbol.take(2),
                color = candidate.coinColor,
                fontWeight = FontWeight.ExtraBold,
                fontSize = 12.sp,
            )
        }

        Spacer(Modifier.width(10.dp))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = candidate.pairName,
                color = TextPrimary,
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp,
            )
            Text(
                text = "Price: $${String.format("%.2f", candidate.currentMarketPrice)}",
                color = TextSecondary,
                fontSize = 11.sp,
            )
            Text(
                text = "Min Notional: $${String.format("%.2f", candidate.minNotional)}",
                color = CyanPrimary,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }

        Box(
            modifier = Modifier
                .border(1.dp, ProfitGreen, RoundedCornerShape(6.dp))
                .padding(horizontal = 8.dp, vertical = 4.dp),
        ) {
            Text(
                text = "${candidate.notations}+ NOTATIONS",
                color = ProfitGreen,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.3.sp,
            )
        }
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

// ─── Mapper from DTO to screen model ──────────────────────────────────────────
fun List<MarketCandidateDto>.toScreenCandidates(): List<MarketCandidate> {
    val coinColors = mapOf(
        "BTC" to Color(0xFFF7931A),
        "ETH" to Color(0xFF627EEA),
        "BNB" to Color(0xFFF3BA2F),
        "SOL" to Color(0xFF9945FF),
        "XRP" to Color(0xFF00AAE4),
        "USDT" to Color(0xFF26A17B),
        "USDC" to Color(0xFF2775CA),
        "DOGE" to Color(0xFFC2A633),
        "ADA" to Color(0xFF0033AD),
        "AVAX" to Color(0xFFE84142),
        "DOT" to Color(0xFFE6007A),
        "LINK" to Color(0xFF375BD2),
        "MATIC" to Color(0xFF8247E5),
        "NEAR" to Color(0xFF00C1DE),
        "ARB" to Color(0xFF12AAFF),
        "IMX" to Color(0xFF17B5CB),
        "RNDR" to Color(0xFFE95F2B),
    )
    return this.map { dto ->
        val symbol = dto.symbol.uppercase(Locale.getDefault())
        MarketCandidate(
            rank = dto.rank,
            symbol = symbol,
            pairName = "$symbol/USDT",
            coinName = symbol,
            notations = dto.score.toInt(),
            currentMarketPrice = dto.currentMarketPrice,
            minNotional = dto.minNotional,
            coinColor = coinColors[symbol] ?: Color(0xFF00B4FF),
            volume24h = dto.volume24h,
            quoteVolume24h = dto.quoteVolume24h,
            priceChangePercent24h = dto.priceChangePercent24h,
            score = dto.score,
        )
    }
}


