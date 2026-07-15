package com.cryptopulse.app.ui.screens

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
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
import androidx.compose.ui.viewinterop.AndroidView
import androidx.hilt.navigation.compose.hiltViewModel
import com.cryptopulse.app.ui.components.CryptoPulseTopBar
import com.cryptopulse.app.ui.components.GlowCard
import com.cryptopulse.app.ui.components.GradientButton
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.theme.*
import com.google.gson.Gson
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@SuppressLint("SetJavaScriptEnabled")
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LivePnLMonitoringScreen(
    candidate: MarketCandidate,
    entryPrice: Double,
    stopLossPrice: Double,
    takeProfitPrice: Double,
    positionSize: Double,
    onBack: () -> Unit,
    onNavigateToPositions: () -> Unit = {},
    viewModel: ExchangeViewModel = hiltViewModel(LocalContext.current as ComponentActivity),
) {
    val bgGradient = Brush.verticalGradient(listOf(NavyDeep, NavyDark, Color(0xFF071020)))

    var livePrice by remember { mutableDoubleStateOf(candidate.currentMarketPrice) }
    var pnl by remember { mutableDoubleStateOf(0.0) }
    var pnlPercent by remember { mutableDoubleStateOf(0.0) }
    var lastUpdated by remember { mutableStateOf(System.currentTimeMillis()) }
    var isLoading by remember { mutableStateOf(true) }

    val klines by viewModel.klines.collectAsState(initial = emptyList())
    val webViewRef = remember { mutableStateOf<WebView?>(null) }
    var pageReady by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()

    LaunchedEffect(candidate.symbol) {
        viewModel.fetchKlines()
        while (true) {
            try {
                val ticker = viewModel.ticker.value
                if (ticker != null) {
                    livePrice = ticker.price
                    pnl = (livePrice - entryPrice) / entryPrice * positionSize
                    pnlPercent = (livePrice - entryPrice) / entryPrice * 100
                    lastUpdated = System.currentTimeMillis()
                    isLoading = false
                }
            } catch (e: Exception) {
                // Silently fail
            }
            delay(3000)
        }
    }

    LaunchedEffect(Unit) {
        viewModel.fetchTicker()
        while (true) {
            delay(5000)
            viewModel.fetchTicker()
        }
    }

    // Push historical candles into the chart once both data and the page are ready.
    LaunchedEffect(klines, pageReady) {
        if (klines.isNotEmpty() && pageReady) {
            val data = klines.map { k ->
                mapOf(
                    "time" to (k.openTime / 1000),
                    "open" to k.open,
                    "high" to k.high,
                    "low" to k.low,
                    "close" to k.close,
                )
            }
            val json = Gson().toJson(data)
            webViewRef.value?.evaluateJavascript("window.cpSetCandles($json)", null)
        }
    }

    // Draw entry/SL/TP lines once chart is ready.
    LaunchedEffect(pageReady, entryPrice, stopLossPrice, takeProfitPrice) {
        if (pageReady) {
            webViewRef.value?.evaluateJavascript("window.cpDrawLine('entry', $entryPrice, '#00b4ff', 'Entry')", null)
            webViewRef.value?.evaluateJavascript("window.cpDrawLine('stop', $stopLossPrice, '#ff5252', 'Stop Loss')", null)
            webViewRef.value?.evaluateJavascript("window.cpDrawLine('tp', $takeProfitPrice, '#00bfa5', 'Take Profit')", null)
        }
    }

    // Update the last candle with the live price.
    LaunchedEffect(livePrice) {
        if (pageReady) {
            webViewRef.value?.evaluateJavascript("window.cpUpdatePrice($livePrice)", null)
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

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp),
            ) {
                Spacer(Modifier.height(12.dp))

                Text(
                    text = "LIVE P&L MONITORING",
                    color = CyanPrimary,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = 22.sp,
                    letterSpacing = 2.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${candidate.pairName} • Real-time Trade Monitoring",
                    color = TextSecondary,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(14.dp))

                CoinInfoCard(candidate = candidate)

                Spacer(Modifier.height(14.dp))

                GlowCard {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.ShowChart, null, tint = Color(0xFFBB86FC), modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "LIVE MARKET CHART",
                                color = Color(0xFFBB86FC),
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                letterSpacing = 1.2.sp,
                            )
                        }
                        Spacer(Modifier.height(12.dp))

                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(250.dp)
                                .background(NavyCard, RoundedCornerShape(10.dp))
                                .border(1.dp, NavyBorder, RoundedCornerShape(10.dp)),
                        ) {
                            AndroidView(
                                factory = { context ->
                                    WebView(context).apply {
                                        layoutParams = ViewGroup.LayoutParams(
                                            ViewGroup.LayoutParams.MATCH_PARENT,
                                            ViewGroup.LayoutParams.MATCH_PARENT,
                                        )
                                        settings.javaScriptEnabled = true
                                        settings.domStorageEnabled = true
                                        settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
                                        webViewClient = object : WebViewClient() {
                                            override fun onPageFinished(view: WebView?, url: String?) {
                                                super.onPageFinished(view, url)
                                                pageReady = true
                                            }
                                        }
                                        loadDataWithBaseURL(
                                            null,
                                            buildChartHtml(),
                                            "text/html",
                                            "utf8",
                                            null,
                                        )
                                    }.also { webViewRef.value = it }
                                },
                                update = { webView ->
                                    webViewRef.value = webView
                                },
                            )
                        }
                    }
                }

                Spacer(Modifier.height(14.dp))

                GlowCard {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Speed, null, tint = Color(0xFFBB86FC), modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "TRADE DETAILS",
                                color = Color(0xFFBB86FC),
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp,
                                letterSpacing = 1.2.sp,
                            )
                        }
                        Spacer(Modifier.height(12.dp))
                        Divider(color = NavyBorder, thickness = 0.5.dp)
                        Spacer(Modifier.height(10.dp))

                        SummaryRow("Open Price", "${"%.2f".format(candidate.currentMarketPrice)} USDT", TextPrimary)
                        SummaryRow("Entry Price", "${"%.2f".format(entryPrice)} USDT", CyanPrimary)
                        SummaryRow("Stop Loss", "${"%.2f".format(stopLossPrice)} USDT", LossRed)
                        SummaryRow("Take Profit", "${"%.2f".format(takeProfitPrice)} USDT", ProfitGreen)
                        SummaryRow("Position Size", "${"%.2f".format(positionSize)} USDT", TextPrimary)

                        Spacer(Modifier.height(10.dp))
                        Divider(color = NavyBorder, thickness = 0.5.dp)
                        Spacer(Modifier.height(10.dp))

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column {
                                Text("LIVE PRICE", color = TextMuted, fontSize = 10.sp, letterSpacing = 0.5.sp)
                                Text(
                                    text = "$${"%.2f".format(livePrice)}",
                                    color = if (pnl >= 0) ProfitGreen else LossRed,
                                    fontSize = 18.sp,
                                    fontWeight = FontWeight.ExtraBold,
                                )
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text("LIVE P&L", color = TextMuted, fontSize = 10.sp, letterSpacing = 0.5.sp)
                                Text(
                                    text = "${if (pnl >= 0) "+" else ""}${"%.2f".format(pnl)} USDT",
                                    color = if (pnl >= 0) ProfitGreen else LossRed,
                                    fontSize = 16.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                                Text(
                                    text = "${if (pnlPercent >= 0) "+" else ""}${"%.2f".format(pnlPercent)}%",
                                    color = if (pnlPercent >= 0) ProfitGreen else LossRed,
                                    fontSize = 12.sp,
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0x1400B4FF), RoundedCornerShape(10.dp))
                        .border(1.dp, CyanPrimary.copy(alpha = 0.2f), RoundedCornerShape(10.dp))
                        .padding(12.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(Icons.Default.Info, null, tint = CyanPrimary, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "Monitoring ${candidate.pairName} in real-time. Prices update every 3 seconds. The bot will automatically execute trades when conditions are met.",
                        color = TextSecondary,
                        fontSize = 11.sp,
                        lineHeight = 17.sp,
                    )
                }

                Spacer(Modifier.height(12.dp))

                GradientButton(
                    text = "View All Positions",
                    onClick = onNavigateToPositions,
                    leadingIcon = Icons.Default.List,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(12.dp))

                Text(
                    text = "Last updated: ${java.text.SimpleDateFormat("HH:mm:ss").format(java.util.Date(lastUpdated))}",
                    color = TextMuted,
                    fontSize = 10.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

private fun buildChartHtml(): String {
    return """
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
            <style>
                body { margin: 0; padding: 0; background: #0a0e17; }
                #chart { width: 100%; height: 100vh; }
            </style>
        </head>
        <body>
            <div id="chart"></div>
            <script>
                var chart = null;
                var series = null;
                var lines = {};
                function initChart() {
                    if (series) return;
                    chart = LightweightCharts.createChart(document.getElementById('chart'), {
                        layout: { background: { color: '#0a0e17' }, textColor: '#d1d5db' },
                        grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
                        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
                        rightPriceScale: { borderColor: '#485460' },
                        timeScale: { borderColor: '#485460', timeVisible: true, secondsVisible: false },
                    });
                    series = chart.addCandlestickSeries({
                        upColor: '#00bfa5',
                        downColor: '#ff5252',
                        borderVisible: false,
                        wickUpColor: '#00bfa5',
                        wickDownColor: '#ff5252',
                    });
                    chart.timeScale().fitContent();
                }
                window.cpSetCandles = function (json) {
                    initChart();
                    var data = json;
                    series.setData(data);
                    chart.timeScale().fitContent();
                };
                window.cpUpdatePrice = function (price) {
                    if (!series) return;
                    var bars = series.data();
                    if (!bars || !bars.length) return;
                    var last = bars[bars.length - 1];
                    var close = parseFloat(price);
                    last.close = close;
                    if (close > last.high) last.high = close;
                    if (close < last.low) last.low = close;
                    series.update(last);
                };
                window.cpDrawLine = function (id, price, color, label) {
                    initChart();
                    if (lines[id]) {
                        lines[id].setPrice(price);
                        return;
                    }
                    lines[id] = series.createPriceLine({
                        price: price,
                        color: color,
                        lineWidth: 2,
                        lineStyle: LightweightCharts.LineStyle.Dashed,
                        axisLabelVisible: true,
                        title: label,
                    });
                };
                initChart();
            </script>
        </body>
        </html>
    """.trimIndent()
}

@Composable
private fun SummaryRow(label: String, value: String, valueColor: Color) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = TextSecondary, fontSize = 13.sp)
        Text(value, color = valueColor, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}
