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
import androidx.compose.runtime.remember
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.navigation
import androidx.navigation.compose.rememberNavController
import androidx.activity.viewModels
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.domain.repository.AuthRepository
import com.cryptopulse.app.ui.auth.AuthScreen
import com.cryptopulse.app.ui.auth.AuthViewModel
import com.cryptopulse.app.ui.auth.ExchangeViewModel
import com.cryptopulse.app.ui.screens.SplashScreen
import com.cryptopulse.app.ui.screens.ConnectExchangeScreen
import com.cryptopulse.app.ui.screens.MarketCandidatesScreen

import com.cryptopulse.app.ui.screens.TradeSetupScreen
import com.cryptopulse.app.ui.screens.UserOnboardingScreen
import com.cryptopulse.app.ui.screens.TradeAlertScreen
import com.cryptopulse.app.ui.screens.PortfolioScreen
import com.cryptopulse.app.ui.screens.StrategySelectionScreen
import com.cryptopulse.app.ui.screens.TechnicalAnalysisScreen
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
    lateinit var exchangeRepository: com.cryptopulse.app.domain.repository.ExchangeRepository

    @Inject
    lateinit var authRepository: AuthRepository

    @Inject
    lateinit var botRepository: com.cryptopulse.app.domain.repository.BotRepository

    @Inject
    lateinit var fcmRepository: com.cryptopulse.app.domain.repository.FcmRepository

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
                    val coroutineScope = rememberCoroutineScope()

                    val performLogout: () -> Unit = {
                        try {
                            val entry = navController.getBackStackEntry("authenticated_flow")
                            val viewModel = androidx.lifecycle.ViewModelProvider(entry)[ExchangeViewModel::class.java]
                            viewModel.resetState()
                        } catch (e: Exception) {
                            // If authenticated_flow is not on backstack, state is already destroyed
                        }
                        coroutineScope.launch {
                            authRepository.logout()
                            exchangeConnectionManager.clearConnection()
                            BackgroundMonitoringService.stopService(this@MainActivity)
                        }
                        navController.navigate("onboarding") {
                            popUpTo("authenticated_flow") {
                                inclusive = true
                            }
                        }
                    }

                    LaunchedEffect(navController) {
                        navController.addOnDestinationChangedListener { _, destination, _ ->
                            android.util.Log.d("Navigation", "[DIAGNOSTIC] Destination = ${destination.route}")
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
                                exchangeRepository = exchangeRepository,
                                botRepository = botRepository,
                            )
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
                                    navController.navigate("authenticated_flow") {
                                        popUpTo("auth") {
                                            inclusive = true
                                        }
                                    }
                                }
                            )
                        }
                        navigation(startDestination = "connect_exchange", route = "authenticated_flow") {
                            composable("connect_exchange") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val viewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                ConnectExchangeScreen(
                                    navController = navController,
                                    viewModel = viewModel
                                )
                            }
                            composable("market_candidates") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val viewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                                MarketCandidatesScreen(
                                    viewModel = viewModel,
                                    onCandidateClick = { candidate ->
                                        viewModel.selectCandidate(candidate)
                                        navController.navigate("strategy_selection")
                                    },
                                    onBack = { navController.popBackStack() }
                                )
                            }
                            composable("strategy_selection") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val exchangeViewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                val strategyViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.StrategySelectionViewModel>()
                                val selectedCandidate by exchangeViewModel.selectedCandidate.collectAsState(initial = null)

                                val candidate = selectedCandidate ?: MarketCandidate(
                                    rank = 1,
                                    symbol = "BTC",
                                    pairName = "BTC/USDT",
                                    coinName = "Bitcoin",
                                    notations = 100,
                                    currentMarketPrice = 50000.0,
                                    minNotional = 0.0,
                                    coinColor = Color(0xFFF7931A),
                                )

                                StrategySelectionScreen(
                                    candidate = candidate,
                                    onBack = { navController.popBackStack() },
                                    onProceedToTradeSetup = {
                                        navController.navigate("trade_setup")
                                    },
                                    viewModel = strategyViewModel
                                )
                            }

                            composable("trade_setup") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val exchangeViewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                val tradeSetupViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.TradeSetupViewModel>()
                                val strategyViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.StrategySelectionViewModel>()
                                val technicalAnalysisViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.TechnicalAnalysisViewModel>()
                                val selectedCandidate by exchangeViewModel.selectedCandidate.collectAsState(initial = null)

                                val candidate = selectedCandidate ?: MarketCandidate(
                                    rank = 1,
                                    symbol = "BTC",
                                    pairName = "BTC/USDT",
                                    coinName = "Bitcoin",
                                    notations = 100,
                                    currentMarketPrice = 50000.0,
                                    minNotional = 0.0,
                                    coinColor = Color(0xFFF7931A),
                                )

                                TradeSetupScreen(
                                    candidate = candidate,
                                    onBack = { navController.popBackStack() },
                                    onProceedToAnalysis = {
                                        val result = tradeSetupViewModel.buildConfig(candidate.symbol)
                                        val strategyId = strategyViewModel.selectedStrategyId.value ?: "scalper-v2"
                                        val config = if (result is com.cryptopulse.app.ui.strategies.TradeSetupConfigResult.Success) result.config else null
                                        technicalAnalysisViewModel.activateBot(
                                            symbol = candidate.symbol,
                                            strategy = strategyId,
                                            config = config,
                                            onSuccess = {
                                                com.cryptopulse.app.service.BackgroundMonitoringService.startService(applicationContext)
                                                navController.navigate("technical_analysis") {
                                                    popUpTo("trade_setup") { inclusive = true }
                                                }
                                            }
                                        )
                                    },
                                    viewModel = tradeSetupViewModel,
                                )
                            }

                            composable("technical_analysis") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val viewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                val technicalAnalysisViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.TechnicalAnalysisViewModel>()
                                val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                                val analysisState by technicalAnalysisViewModel.analysisState.collectAsState()

                                val candidate = selectedCandidate ?: MarketCandidate(
                                    rank = 1,
                                    symbol = "BTC",
                                    pairName = "BTC/USDT",
                                    coinName = "Bitcoin",
                                    notations = 100,
                                    currentMarketPrice = 50000.0,
                                    minNotional = 0.0,
                                    coinColor = Color(0xFFF7931A),
                                )

                                LaunchedEffect(candidate.symbol) {
                                    technicalAnalysisViewModel.loadPreviewAnalysis(candidate.symbol, "ScalperV2")
                                }

                                LaunchedEffect(Unit) {
                                    AlertBus.alerts.collect { alert ->
                                        viewModel.setPendingAlert(alert)
                                        navController.navigate("trade_alert")
                                    }
                                }

                                val tradeSetupConfig by technicalAnalysisViewModel.tradeSetupConfig.collectAsState()

                                TechnicalAnalysisScreen(
                                    candidate = candidate,
                                    analysisState = analysisState,
                                    tradeSetupConfig = tradeSetupConfig,
                                    onBack = { navController.popBackStack() },
                                    onExecuteMockTrade = { mockAlert ->
                                        com.cryptopulse.app.service.TradeAlertManager.getInstance(applicationContext).onNewAlertReceived(mockAlert)
                                    }
                                )
                            }

                            composable("live_analysis") {
                                navController.navigate("technical_analysis") {
                                    popUpTo("live_analysis") { inclusive = true }
                                }
                            }

                            composable("trade_alert") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val viewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                val alert by viewModel.pendingAlert.collectAsState(initial = null)
                                val candidate by viewModel.selectedCandidate.collectAsState(initial = null)

                                val alertSymbol = (alert?.get("symbol") as? String) ?: candidate?.symbol ?: "BTC"
                                val entryPrice = (alert?.get("entryPrice") as? Double)
                                    ?: candidate?.currentMarketPrice ?: 0.0
                                val stopLossPrice = (alert?.get("stopLoss") as? Double)
                                    ?: (entryPrice * 0.99)
                                val takeProfitPrice = (alert?.get("takeProfit") as? Double)
                                    ?: (entryPrice * 1.02)
                                val signalPrice = (alert?.get("signalPrice") as? Double) ?: entryPrice
                                val targetEntryPrice = (alert?.get("targetEntryPrice") as? Double)
                                
                                val positionSize = (alert?.get("positionSize") as? Double) ?: 0.0
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
                                        navController.navigate("portfolio") {
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
                                    tradeAmountUsdt = positionSize,
                                )
                            }

                            composable("portfolio") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val viewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                PortfolioScreen(
                                    viewModel = viewModel,
                                    onBack = { navController.popBackStack() }
                                )
                            }
                        }
                    }
                    }
                }
            }

            LaunchedEffect(Unit) {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                    if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
                    }
                }
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
                            fcmRepository.registerToken(fcmToken)
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
            val positionSize = if (intent.hasExtra("alert_position_size")) intent.getDoubleExtra("alert_position_size", 0.0) else null
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
                if (positionSize != null && positionSize > 0.0) {
                    alert["positionSize"] = positionSize
                }
                com.cryptopulse.app.service.TradeAlertManager.getInstance(applicationContext).onNewAlertReceived(alert)
            }
        }
    }
}



