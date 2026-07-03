package com.cryptopulse.ui.screens

import android.annotation.SuppressLint
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavController
import com.cryptopulse.ui.market.MarketViewModel
import com.google.accompanist.web.WebView
import com.google.accompanist.web.rememberWebViewState

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun LiveTradeMonitoringScreen(
    navController: NavController,
    coinId: String,
    viewModel: MarketViewModel = hiltViewModel()
) {
    val tradingViewHtml = """
        <!-- TradingView Widget BEGIN -->
        <div class="tradingview-widget-container">
          <div id="tradingview_f1337"></div>
          <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
          <script type="text/javascript">
          new TradingView.widget(
          {
          "autosize": true,
          "symbol": "BINANCE:${coinId.uppercase()}USDT",
          "interval": "1",
          "timezone": "Etc/UTC",
          "theme": "dark",
          "style": "1",
          "locale": "en",
          "enable_publishing": false,
          "allow_symbol_change": false,
          "container_id": "tradingview_f1337"
        }
          );
          </script>
        </div>
        <!-- TradingView Widget END -->
    """.trimIndent()

    val webViewState = rememberWebViewState(data = tradingViewHtml, baseUrl = "https://s3.tradingview.com")

    // Mock P&L data for UI purposes
    val currentPnl by remember { mutableStateOf(12.35f) }
    val isProfit = currentPnl >= 0

    Scaffold(
        topBar = { TopAppBar(title = { Text("Live Trade: ${coinId.uppercase()}") }) },
    ) { padding ->
        Column(modifier = Modifier.padding(padding)) {
            // P&L and Status section
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column {
                    Text("Current P&L", style = MaterialTheme.typography.labelMedium)
                    Text(
                        text = (if (isProfit) "+" else "") + "$${"%.2f".format(currentPnl)}",
                        style = MaterialTheme.typography.headlineSmall,
                        color = if (isProfit) Color(0xFF00C853) else MaterialTheme.colorScheme.error
                    )
                }
                Button(
                    onClick = {
                        viewModel.stopTrade()
                        navController.navigate(Screen.MarketCandidates.route) {
                            popUpTo(Screen.MarketCandidates.route) { inclusive = true }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                ) {
                    Text("Stop Trade")
                }
            }
            WebView(state = webViewState, modifier = Modifier.weight(1f), onCreated = { it.settings.javaScriptEnabled = true })
        }
    }
}