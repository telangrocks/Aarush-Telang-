package com.cryptopulse.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.lifecycleScope
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.activity.viewModels
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.ui.auth.AuthScreen
import com.cryptopulse.app.ui.auth.AuthViewModel
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.screens.SplashScreen
import com.cryptopulse.app.ui.screens.ConnectExchangeScreen
import com.cryptopulse.app.ui.screens.MarketCandidatesScreen
import com.cryptopulse.app.ui.screens.TradeConfirmationScreen
import com.cryptopulse.app.ui.screens.TradeSetupScreen
import com.cryptopulse.app.ui.screens.UserOnboardingScreen
import com.cryptopulse.app.ui.screens.WelcomeScreen
import com.cryptopulse.app.ui.screens.TradeAlertScreen
import com.cryptopulse.app.ui.screens.LivePnLMonitoringScreen
import com.cryptopulse.app.ui.screens.PositionsScreen
import com.cryptopulse.app.ui.screens.StrategySelectionScreen
import com.cryptopulse.app.ui.screens.TechnicalAnalysisScreen
import com.cryptopulse.app.ui.screens.LiveAnalysisScreen
import com.cryptopulse.app.ui.screens.LiveAnalysisViewModel
import com.cryptopulse.app.service.BackgroundMonitoringService
import com.cryptopulse.app.service.AlertBus
import com.cryptopulse.app.ui.theme.CryptoPulseTheme
import com.cryptopulse.app.ui.screens.MarketCandidate
import com.cryptopulse.app.ui.auth.TradeSetupState
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var tokenManager: TokenManager

    @Inject
    lateinit var exchangeConnectionManager: ExchangeConnectionManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CryptoPulseTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val navController = rememberNavController()
                    val token by tokenManager.tokenFlow.collectAsState(initial = null)
                    val startDestination = "splash"

                    NavHost(navController = navController, startDestination = startDestination) {
                        composable("splash") {
                            SplashScreen(navController = navController, tokenManager = tokenManager, exchangeConnectionManager = exchangeConnectionManager)
                        }
                        composable("welcome") {
                            WelcomeScreen(navController = navController)
                        }
                        composable("onboarding") {
                            val viewModel = hiltViewModel<AuthViewModel>()
                            UserOnboardingScreen(
                                navController = navController,
                                viewModel = viewModel
                            )
                        }
                        composable("auth") {
                            val viewModel = hiltViewModel<AuthViewModel>()
                            AuthScreen(
                                viewModel = viewModel,
                                onAuthSuccess = {
                                    navController.navigate("connect_exchange") {
                                        popUpTo("welcome") { inclusive = true }
                                    }
                                }
                            )
                        }
                        composable("connect_exchange") {
                            val viewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            ConnectExchangeScreen(
                                navController = navController,
                                viewModel = viewModel
                            )
                        }
                        composable("market_candidates") {
                            val viewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                            MarketCandidatesScreen(
                                onCandidateClick = { candidate ->
                                    viewModel.selectCandidate(candidate)
                                    navController.navigate("trade_setup")
                                },
                                onBack = { navController.popBackStack() }
                            )
                        }
                        composable("trade_setup") {
                            val viewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                            val candidate = selectedCandidate ?: MarketCandidate(
                                rank = 1,
                                symbol = "BTC",
                                pairName = "BTC/USDT",
                                coinName = "Bitcoin",
                                notations = 100,
                                currentMarketPrice = 50000.0,
                                minNotional = 10.0,
                                coinColor = Color(0xFFF7931A),
                            )
                            TradeSetupScreen(
                                candidate = candidate,
                                onBack = { navController.popBackStack() },
                                onProceedToConfirm = { entryPrice, stopLoss, takeProfit, positionSize ->
                                    viewModel.setTradeSetup(entryPrice, stopLoss, takeProfit, positionSize)
                                    navController.navigate("trade_confirmation")
                                },
                                viewModel = viewModel,
                            )
                        }
                        composable("trade_confirmation") {
                            val viewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                            val tradeSetup by viewModel.tradeSetup.collectAsState(initial = null)
                            val candidate = selectedCandidate ?: MarketCandidate(
                                rank = 1,
                                symbol = "BTC",
                                pairName = "BTC/USDT",
                                coinName = "Bitcoin",
                                notations = 100,
                                currentMarketPrice = 50000.0,
                                minNotional = 10.0,
                                coinColor = Color(0xFFF7931A),
                            )
                            val setup = tradeSetup ?: TradeSetupState(
                                entryPrice = candidate.currentMarketPrice,
                                stopLossPrice = candidate.currentMarketPrice * 0.99,
                                takeProfitPrice = candidate.currentMarketPrice * 1.02,
                                positionSize = 100.0,
                            )
                            TradeConfirmationScreen(
                                candidate = candidate,
                                entryPrice = setup.entryPrice,
                                stopLossPrice = setup.stopLossPrice,
                                takeProfitPrice = setup.takeProfitPrice,
                                positionSize = setup.positionSize,
                                onBack = { navController.popBackStack() },
                                viewModel = viewModel,
                                onConfirmTrade = {
                                    navController.navigate("strategy_selection")
                                }
                            )
                        }
                        composable("strategy_selection") {
                            val viewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                            val candidate = selectedCandidate ?: MarketCandidate(
                                rank = 1,
                                symbol = "BTC",
                                pairName = "BTC/USDT",
                                coinName = "Bitcoin",
                                notations = 100,
                                currentMarketPrice = 50000.0,
                                minNotional = 10.0,
                                coinColor = Color(0xFFF7931A),
                            )
                            LaunchedEffect(Unit) {
                                viewModel.fetchStrategies()
                            }
                            StrategySelectionScreen(
                                candidate = candidate,
                                onBack = { navController.popBackStack() },
                                viewModel = viewModel,
                                onStrategySelected = { strategy ->
                                    viewModel.selectStrategy(strategy)
                                    viewModel.fetchTechnicalAnalysis()
                                    navController.navigate("technical_analysis")
                                }
                            )
                        }
                        composable("technical_analysis") {
                            val viewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                            val selectedStrategy by viewModel.selectedStrategy.collectAsState(initial = null)
                            val candidate = selectedCandidate ?: MarketCandidate(
                                rank = 1,
                                symbol = "BTC",
                                pairName = "BTC/USDT",
                                coinName = "Bitcoin",
                                notations = 100,
                                currentMarketPrice = 50000.0,
                                minNotional = 10.0,
                                coinColor = Color(0xFFF7931A),
                            )
                            val strategy = selectedStrategy ?: "scalping"

                            LaunchedEffect(Unit) {
                                AlertBus.alerts.collect { alert ->
                                    viewModel.setPendingAlert(alert)
                                    navController.navigate("trade_alert")
                                }
                            }

                            TechnicalAnalysisScreen(
                                candidate = candidate,
                                strategy = strategy,
                                onBack = { navController.popBackStack() },
                                onBotActivated = {
                                    navController.navigate("live_analysis") {
                                        popUpTo("technical_analysis") { inclusive = false }
                                    }
                                },
                                viewModel = viewModel,
                            )
                        }
                        composable("live_analysis") {
                            val viewModel = hiltViewModel<LiveAnalysisViewModel>(LocalContext.current as ComponentActivity)
                            val exchangeViewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            LiveAnalysisScreen(
                                onBack = { navController.popBackStack() },
                                onStopBot = {
                                    navController.navigate("positions") {
                                        popUpTo("live_analysis") { inclusive = true }
                                    }
                                },
                                onOpportunity = { alert ->
                                    exchangeViewModel.setPendingBotAlert(alert)
                                    navController.navigate("trade_alert")
                                },
                            )
                        }
                        composable("trade_alert") {
                            val viewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            val alert by viewModel.pendingAlert.collectAsState(initial = null)
                            val candidate by viewModel.selectedCandidate.collectAsState(initial = null)

                            // Render the popup directly from the genuine opportunity
                            // the backend detected — not from any stale manual setup.
                            val alertSymbol = (alert?.get("symbol") as? String) ?: candidate?.symbol ?: "BTC"
                            val entryPrice = (alert?.get("entryPrice") as? Double)
                                ?: candidate?.currentMarketPrice ?: 0.0
                            val stopLossPrice = (alert?.get("stopLoss") as? Double)
                                ?: (entryPrice * 0.99)
                            val takeProfitPrice = (alert?.get("takeProfit") as? Double)
                                ?: (entryPrice * 1.02)
                            val estimatedPnl = (alert?.get("estimatedPnl") as? Double)
                                ?: if (entryPrice > 0) (takeProfitPrice - entryPrice) / entryPrice * 100.0 else 0.0

                            val marketCandidate = candidate ?: MarketCandidate(
                                rank = 1,
                                symbol = alertSymbol,
                                pairName = "$alertSymbol/USDT",
                                coinName = alertSymbol,
                                notations = 100,
                                currentMarketPrice = entryPrice,
                                minNotional = 10.0,
                                coinColor = Color(0xFFF7931A),
                            )
                            TradeAlertScreen(
                                onBack = { navController.popBackStack() },
                                onTradeExecuted = {
                                    navController.navigate("live_pnl_monitoring") {
                                        popUpTo("technical_analysis") { inclusive = false }
                                    }
                                },
                                candidate = marketCandidate,
                                entryPrice = entryPrice,
                                stopLossPrice = stopLossPrice,
                                takeProfitPrice = takeProfitPrice,
                                estimatedPnl = estimatedPnl,
                            )
                        }
                        composable("live_pnl_monitoring") {
                            val viewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                            val tradeSetup by viewModel.lastTrade.collectAsState(initial = null)
                            val candidate = selectedCandidate ?: MarketCandidate(
                                rank = 1,
                                symbol = "BTC",
                                pairName = "BTC/USDT",
                                coinName = "Bitcoin",
                                notations = 100,
                                currentMarketPrice = 50000.0,
                                minNotional = 10.0,
                                coinColor = Color(0xFFF7931A),
                            )
                            val setup = tradeSetup ?: TradeSetupState(
                                entryPrice = candidate.currentMarketPrice,
                                stopLossPrice = candidate.currentMarketPrice * 0.99,
                                takeProfitPrice = candidate.currentMarketPrice * 1.02,
                                positionSize = 100.0,
                            )
                            LivePnLMonitoringScreen(
                                candidate = candidate,
                                entryPrice = setup.entryPrice,
                                stopLossPrice = setup.stopLossPrice,
                                takeProfitPrice = setup.takeProfitPrice,
                                positionSize = setup.positionSize,
                                onBack = { navController.popBackStack() },
                                onNavigateToPositions = { navController.navigate("positions") },
                            )
                        }
                        composable("positions") {
                            PositionsScreen(
                                onBack = { navController.popBackStack() }
                            )
                        }
                    }
                }
            }

            lifecycleScope.launch {
                try {
                    val token = tokenManager.getToken()
                    if (!token.isNullOrEmpty()) {
                        val fcmToken = try {
                            com.google.firebase.messaging.FirebaseMessaging.getInstance().token.result
                        } catch (e: Exception) {
                            null
                        }
                        if (!fcmToken.isNullOrEmpty()) {
                            val viewModel: ExchangeViewModel by viewModels()
                            viewModel.registerFcmToken(fcmToken)
                        }
                    }
                } catch (e: Exception) {
                    // Silently fail - FCM registration is optional
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra("extra_alert", false)) {
            val entryPrice = intent.getDoubleExtra("alert_entry_price", 0.0)
            val stopLoss = intent.getDoubleExtra("alert_stop_loss", 0.0)
            val takeProfit = intent.getDoubleExtra("alert_take_profit", 0.0)
            val estimatedPnl = intent.getDoubleExtra("alert_estimated_pnl", 0.0)
            val alertId = intent.getStringExtra("alert_id")
            if (entryPrice > 0 && alertId != null) {
                val alert = mapOf(
                    "id" to alertId,
                    "symbol" to (intent.getStringExtra("alert_symbol") ?: "UNKNOWN"),
                    "entryPrice" to entryPrice,
                    "stopLoss" to stopLoss,
                    "takeProfit" to takeProfit,
                    "estimatedPnl" to estimatedPnl,
                )
                lifecycleScope.launch {
                    AlertBus.send(alert)
                }
            }
        }
    }
}

@Composable
fun Greeting(name: String, modifier: Modifier = Modifier) {
    Text(
        text = "Welcome to $name!",
        modifier = modifier.padding(16.dp)
    )
}

@Preview(showBackground = true)
@Composable
fun GreetingPreview() {
    CryptoPulseTheme {
        Greeting("Crypto Pulse")
    }
}
