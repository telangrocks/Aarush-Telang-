package com.cryptopulse.app.ui.screens

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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.theme.*
import java.text.SimpleDateFormat
import java.util.*

// ─── Data model for the screen ────────────────────────────────────────────────
data class MarketCandidate(
    val rank: Int,
    val symbol: String,          // e.g. "SOL"
    val pairName: String,        // e.g. "SOL/USDT"
    val coinName: String,        // e.g. "Solana"
    val notations: Int,          // e.g. 95
    val currentMarketPrice: Double,
    val coinColor: Color,        // brand colour for the coin avatar
)

// Sample data — replace with real API data when the MarketViewModel is wired
private val sampleCandidates = listOf(
    MarketCandidate(1,  "SOL",  "SOL/USDT",  "Solana",        95,  172.45, Color(0xFF9945FF)),
    MarketCandidate(2,  "AVAX", "AVAX/USDT", "Avalanche",     92,   36.20, Color(0xFFE84142)),
    MarketCandidate(3,  "MATIC","MATIC/USDT","Polygon",        88,    0.91, Color(0xFF8247E5)),
    MarketCandidate(4,  "LINK", "LINK/USDT", "Chainlink",     85,   14.30, Color(0xFF375BD2)),
    MarketCandidate(5,  "ATOM", "ATOM/USDT", "Cosmos",        82,    9.15, Color(0xFF6F7390)),
    MarketCandidate(6,  "BNB",  "BNB/USDT",  "Binance Coin",  80,  597.80, Color(0xFFF3BA2F)),
    MarketCandidate(7,  "NEAR", "NEAR/USDT", "NEAR Protocol", 78,    6.10, Color(0xFF00C1DE)),
    MarketCandidate(8,  "ARB",  "ARB/USDT",  "Arbitrum",      75,    1.08, Color(0xFF12AAFF)),
    MarketCandidate(9,  "IMX",  "IMX/USDT",  "Immutable X",   72,    2.45, Color(0xFF17B5CB)),
    MarketCandidate(10, "RNDR", "RNDR/USDT", "Render Token",  70,    7.90, Color(0xFFE95F2B)),
)

// ─────────────────────────────────────────────────────────────────────────────
// Market Candidates Screen
// ─────────────────────────────────────────────────────────────────────────────
@Composable
fun MarketCandidatesScreen(
    onCandidateClick: (MarketCandidate) -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    // Live clock for "Updated At" row
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

            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {

                // ── Section heading ───────────────────────────────────────
                item {
                    Spacer(Modifier.height(12.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        // Purple alien badge icon (reference uses a stylized purple orb)
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

                // ── Metadata bar ──────────────────────────────────────────
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

                // ── Table header ──────────────────────────────────────────
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

                // ── Candidate rows ────────────────────────────────────────
                itemsIndexed(sampleCandidates) { _, candidate ->
                    CandidateRow(candidate = candidate, onClick = { onCandidateClick(candidate) })
                    Divider(color = NavyBorder.copy(alpha = 0.5f), thickness = 0.5.dp)
                }

                // ── Footer disclaimer ─────────────────────────────────────
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
            .padding(vertical = 12.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Rank badge
        RankBadge(rank = candidate.rank)

        Spacer(Modifier.width(10.dp))

        // Coin avatar circle
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

        // Name + pair
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = candidate.pairName,
                color = TextPrimary,
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp,
            )
            Text(
                text = candidate.coinName,
                color = TextSecondary,
                fontSize = 11.sp,
            )
        }

        // Notations badge
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
        2 -> Color(0xFF94A3B8) to Color(0xFF0A0F1A)
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
