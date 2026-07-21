package com.cryptopulse.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.fragment.app.FragmentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
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
import com.cryptopulse.app.data.repository.AuthRepository
import com.cryptopulse.app.ui.auth.AuthScreen
import com.cryptopulse.app.ui.auth.AuthViewModel
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.screens.SplashScreen
import com.cryptopulse.app.ui.screens.ConnectExchangeScreen
import com.cryptopulse.app.ui.screens.MarketCandidatesScreen

import com.cryptopulse.app.ui.screens.TradeSetupScreen
import com.cryptopulse.app.ui.screens.UserOnboardingScreen
import com.cryptopulse.app.ui.screens.WelcomeScreen
import com.cryptopulse.app.ui.screens.TradeAlertScreen
import com.cryptopulse.app.ui.screens.PositionsScreen
import com.cryptopulse.app.ui.screens.StrategySelectionScreen
import com.cryptopulse.app.ui.screens.TechnicalAnalysisScreen
import com.cryptopulse.app.ui.screens.LiveAnalysisScreen
import com.cryptopulse.app.ui.screens.LiveAnalysisViewModel
import com.cryptopulse.app.service.BackgroundMonitoringService
import com.cryptopulse.app.service.AlertBus
import com.cryptopulse.app.ui.theme.CryptoPulseTheme
import com.cryptopulse.app.ui.components.LocalOnLogout
import com.cryptopulse.app.ui.screens.MarketCandidate
import com.cryptopulse.app.ui.auth.TradeSetupState
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : FragmentActivity() {

    @Inject
    lateinit var tokenManager: TokenManager

    @Inject
    lateinit var exchangeConnectionManager: ExchangeConnectionManager

    @Inject
    lateinit var exchangeService: com.cryptopulse.app.data.api.ExchangeService

    @Inject
    lateinit var authRepository: AuthRepository

    @Inject
    lateinit var tradingBotService: com.cryptopulse.app.data.api.TradingBotService

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
                    val exchangeViewModel = hiltViewModel<ExchangeViewModel>(this)
                    val coroutineScope = rememberCoroutineScope()

                    val performLogout: () -> Unit = {
                        coroutineScope.launch {
                            authRepository.logout()
                            exchangeConnectionManager.clearConnection()
                            BackgroundMonitoringService.stopService(this@MainActivity)
                        }
                        exchangeViewModel.resetState()
                        navController.navigate("welcome") {
                            popUpTo("splash") { inclusive = true }
                        }
                    }

                    CompositionLocalProvider(
                        LocalOnLogout provides if (token != null) performLogout else null
                    ) {
                    NavHost(navController = navController, startDestination = startDestination) {
                        composable("splash") {
                            SplashScreen(
                                navController = navController,
                                tokenManager = tokenManager,
                                exchangeConnectionManager = exchangeConnectionManager,
                                exchangeService = exchangeService,
                                tradingBotService = tradingBotService,
                            )
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
                                    navController.navigate("strategy_selection")
                                },
                                onBack = { navController.popBackStack() }
                            )
                        }
                        composable("trade_setup") {
                            val exchangeViewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            val tradeSetupViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.TradeSetupViewModel>()
                            val selectedCandidate by exchangeViewModel.selectedCandidate.collectAsState(initial = null)
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
                                onProceedToConfirm = {
                                    val result = tradeSetupViewModel.buildConfig(candidate.symbol)
                                    if (result is com.cryptopulse.app.ui.strategies.TradeSetupConfigResult.Success) {
                                        navController.navigate("technical_analysis")
                                    }
                                },
                                viewModel = tradeSetupViewModel,
                            )
                        }

                        composable("strategy_selection") {
                            val exchangeViewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            val strategyViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.StrategySelectionViewModel>()
                            val selectedCandidate by exchangeViewModel.selectedCandidate.collectAsState(initial = null)
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
                            StrategySelectionScreen(
                                candidate = candidate,
                                onBack = { navController.popBackStack() },
                                onProceed = { 
                                    val strategyId = strategyViewModel.selectedStrategyId.value
                                    if (strategyId != null) {
                                        navController.navigate("trade_setup") 
                                    }
                                },
                                viewModel = strategyViewModel
                            )
                        }
                        composable("technical_analysis") {
                            val viewModel = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
                            val technicalAnalysisViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.TechnicalAnalysisViewModel>()
                            val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                            val config by technicalAnalysisViewModel.tradeSetupConfig.collectAsState()
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
                            val strategy = config?.strategyId ?: "scalping"

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
                                technicalAnalysisViewModel = technicalAnalysisViewModel
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
                            val signalPrice = (alert?.get("signalPrice") as? Double) ?: entryPrice
                            val targetEntryPrice = (alert?.get("targetEntryPrice") as? Double)
                            
                            // Feature 5: Dynamic Estimated P&L Calculation using (TP - Signal) * Qty (or simulated positionSize/price ratio)
                            val positionSize = (alert?.get("positionSize") as? Double) ?: 100.0
                            val refPrice = targetEntryPrice ?: signalPrice
                            val quantity = if (refPrice > 0.0) positionSize / refPrice else 0.0
                            val calculatedPnl = if (quantity > 0.0) {
                                kotlin.math.abs(takeProfitPrice - signalPrice) * quantity
                            } else {
                                (alert?.get("estimatedPnl") as? Double) ?: 0.0
                            }

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
                                    navController.navigate("positions") {
                                        popUpTo("technical_analysis") { inclusive = false }
                                    }
                                },
                                candidate = marketCandidate,
                                entryPrice = entryPrice,
                                stopLossPrice = stopLossPrice,
                                takeProfitPrice = takeProfitPrice,
                                estimatedPnl = calculatedPnl,
                                signalPrice = signalPrice,
                                targetEntryPrice = targetEntryPrice,
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
            }

            val exchangeViewModelForFcm = hiltViewModel<ExchangeViewModel>(LocalContext.current as ComponentActivity)
            LaunchedEffect(Unit) {
                try {
                    val token = tokenManager.getToken()
                    if (!token.isNullOrEmpty()) {
                        val fcmToken = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                            try {
                                val task = com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                                com.google.android.gms.tasks.Tasks.await(task)
                            } catch (e: Exception) {
                                null
                            }
                        }
                        if (!fcmToken.isNullOrEmpty()) {
                            exchangeViewModelForFcm.registerFcmToken(fcmToken)
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
            val signalPrice = intent.getDoubleExtra("alert_signal_price", entryPrice)
            val targetEntryPrice = if (intent.hasExtra("alert_target_entry_price")) intent.getDoubleExtra("alert_target_entry_price", 0.0) else null
            val alertId = intent.getStringExtra("alert_id")
            if (entryPrice > 0 && alertId != null) {
                val alert = mutableMapOf<String, Any>(
                    "id" to alertId,
                    "symbol" to (intent.getStringExtra("alert_symbol") ?: "UNKNOWN"),
                    "entryPrice" to entryPrice,
                    "stopLoss" to stopLoss,
                    "takeProfit" to takeProfit,
                    "estimatedPnl" to estimatedPnl,
                    "signalPrice" to signalPrice,
                )
                if (targetEntryPrice != null && targetEntryPrice > 0.0) {
                    alert["targetEntryPrice"] = targetEntryPrice
                }
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

