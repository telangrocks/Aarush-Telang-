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
import androidx.compose.runtime.DisposableEffect
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
import com.cryptopulse.app.ui.screens.TechnicalAnalysisScreen
import com.cryptopulse.app.service.BackgroundMonitoringService
import com.cryptopulse.app.service.AlertBus
import com.cryptopulse.app.ui.theme.CryptoPulseTheme
import com.cryptopulse.app.ui.components.LocalOnLogout
import com.cryptopulse.app.ui.screens.MarketCandidate
import com.cryptopulse.app.ui.auth.TradeSetupState
import com.cryptopulse.app.service.TradeAlertManager
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
    lateinit var tradeAlertManager: TradeAlertManager

    @Inject
    lateinit var fcmRepository: com.cryptopulse.app.domain.repository.FcmRepository

    @Inject
    lateinit var tradeSessionRepository: com.cryptopulse.app.domain.repository.TradeSessionRepository

    @Inject
    lateinit var sessionManager: com.cryptopulse.app.data.session.SessionManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIncomingAlertIntent(intent)
        setContent {
            CryptoPulseTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val navController = rememberNavController()
                    val tokenState by tokenManager.tokenFlow.collectAsState(initial = com.cryptopulse.app.data.local.TokenState.Uninitialized)
                    val token = (tokenState as? com.cryptopulse.app.data.local.TokenState.Authenticated)?.token
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
                            sessionManager.performLogout(this@MainActivity)
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
                            com.cryptopulse.app.forensics.CidDiagnosticManager.logNavigation(
                                fromRoute = null,
                                toRoute = destination.route ?: "unknown",
                                trigger = "NAV_CONTROLLER"
                            )
                        }
                    }

                    LaunchedEffect(token) {
                        if (token != null) {
                            AlertBus.alerts.collect { alert ->
                                try {
                                    val parentEntry = navController.getBackStackEntry("authenticated_flow")
                                    val exchangeVm = androidx.lifecycle.ViewModelProvider(parentEntry)[ExchangeViewModel::class.java]
                                    exchangeVm.setPendingAlert(alert)
                                    val currentRoute = navController.currentDestination?.route
                                    if (currentRoute != "trade_alert") {
                                        navController.navigate("trade_alert")
                                    }
                                } catch (e: Exception) {
                                    android.util.Log.w("MainActivity", "[ALERT_BUS] Error routing alert to trade_alert: ${e.message}")
                                }
                            }
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
                                tradeSessionRepository = tradeSessionRepository,
                                authRepository = authRepository,
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
                                val tradeSetupViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.TradeSetupViewModel>(parentEntry)
                                val uiState by tradeSetupViewModel.uiState.collectAsState()
                                val budget = uiState.tradeAmountUsdt.toDoubleOrNull() ?: 5.0
                                
                                val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                                
                                LaunchedEffect(Unit) {
                                    viewModel.fetchMarketCandidates(budget)
                                }
                                
                                MarketCandidatesScreen(
                                    viewModel = viewModel,
                                    budget = budget,
                                    onCandidateClick = {
                                        // Informational overview only: no coin-binding navigation
                                    },
                                    onSetUpTrading = {
                                        navController.navigate("risk_management")
                                    },
                                    onBack = { navController.popBackStack() },
                                    onIncreaseBudget = {
                                        if (!navController.popBackStack("trade_setup", inclusive = false)) {
                                            navController.navigate("trade_setup")
                                        }
                                    },
                                    onChangeApiKeys = {
                                        navController.navigate("change_api_keys")
                                    }
                                )
                            }
                            composable("change_api_keys") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val viewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                ConnectExchangeScreen(
                                    navController = navController,
                                    viewModel = viewModel,
                                    isChangingApiKeys = true
                                )
                            }

                            composable("trade_setup") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val exchangeViewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                val tradeSetupViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.TradeSetupViewModel>(parentEntry)
                                val technicalAnalysisViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.TechnicalAnalysisViewModel>(parentEntry)
                                val selectedCandidate by exchangeViewModel.selectedCandidate.collectAsState(initial = null)
                                val candidates by exchangeViewModel.candidates.collectAsState(initial = emptyList())
                                val balances by exchangeViewModel.balances.collectAsState()
                                val balancesError by exchangeViewModel.balancesError.collectAsState()
                                val formState by exchangeViewModel.formState.collectAsState()

                                val candidate = selectedCandidate ?: candidates.firstOrNull()

                                LaunchedEffect(candidate) {
                                    if (candidate != null && selectedCandidate == null) {
                                        exchangeViewModel.selectCandidate(candidate)
                                    }
                                }

                                LaunchedEffect(Unit) {
                                    exchangeViewModel.fetchBalances()
                                }

                                val parts = candidate?.pairName?.split("/")
                                val quoteAsset = if (parts != null && parts.size >= 2) parts[1] else "USDT"
                                val primaryBalance = balances?.let { list ->
                                    list.find { it.asset.equals(quoteAsset, ignoreCase = true) }?.free ?: 0.0
                                }

                                val isRefreshingBalance = balances == null && balancesError == null
                                TradeSetupScreen(
                                    candidate = candidate,
                                    balance = primaryBalance,
                                    balancesError = balancesError,
                                    asset = quoteAsset,
                                    exchangeName = formState.selectedExchange.replaceFirstChar { it.uppercase() },
                                    environmentName = formState.environment.replaceFirstChar { it.uppercase() },
                                    onBack = { navController.popBackStack() },
                                    onProceedToAnalysis = {
                                        navController.navigate("market_candidates")
                                    },
                                    viewModel = tradeSetupViewModel,
                                    onRefresh = {
                                        if (!isRefreshingBalance) {
                                            exchangeViewModel.fetchBalances()
                                            exchangeViewModel.fetchTicker()
                                        }
                                    },
                                    isRefreshing = isRefreshingBalance,
                                )
                            }

                            composable("risk_management") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val riskViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.RiskManagementViewModel>()
                                val technicalAnalysisViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.TechnicalAnalysisViewModel>(parentEntry)
                                val exchangeViewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                val selectedCandidate by exchangeViewModel.selectedCandidate.collectAsState(initial = null)
                                val candidate = selectedCandidate ?: exchangeViewModel.candidates.collectAsState(initial = emptyList()).value.firstOrNull()

                                if (candidate == null) {
                                    androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                                        Text("Market candidate unavailable", color = MaterialTheme.colorScheme.error)
                                    }
                                    return@composable
                                }

                                com.cryptopulse.app.ui.strategies.RiskManagementScreen(
                                    viewModel = riskViewModel,
                                    onProceedToAnalysis = { updatedConfig ->
                                        tradeSessionRepository.setTradeSetupConfig(updatedConfig)
                                        val initialStrategy = updatedConfig.strategyId ?: "ScalperV2"
                                        technicalAnalysisViewModel.selectStrategy(initialStrategy, candidate.pairName)
                                        navController.navigate("technical_analysis") {
                                            popUpTo("market_candidates") { inclusive = false }
                                        }
                                    },
                                    onBack = { navController.popBackStack() }
                                )
                            }

                            composable("technical_analysis") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val viewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                val technicalAnalysisViewModel = hiltViewModel<com.cryptopulse.app.ui.strategies.TechnicalAnalysisViewModel>(parentEntry)

                                val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                                val candidates by viewModel.candidates.collectAsState(initial = emptyList())
                                val candidate = selectedCandidate ?: candidates.firstOrNull()

                                LaunchedEffect(candidate) {
                                    if (candidate != null && selectedCandidate == null) {
                                        viewModel.selectCandidate(candidate)
                                    }
                                }

                                DisposableEffect(technicalAnalysisViewModel, candidate?.pairName) {
                                    technicalAnalysisViewModel.onScreenStarted(candidate?.pairName)
                                    onDispose {
                                        technicalAnalysisViewModel.onScreenStopped()
                                    }
                                }

                                val tradeSetupConfig by technicalAnalysisViewModel.tradeSetupConfig.collectAsState()
                                val selectedStrategyId by technicalAnalysisViewModel.selectedStrategyId.collectAsState()
                                val viewedStrategyId by technicalAnalysisViewModel.viewedStrategyId.collectAsState()
                                val candidatesError by viewModel.candidatesError.collectAsState()
                                val analysisState by technicalAnalysisViewModel.analysisState.collectAsState()
                                val availableStrategies by technicalAnalysisViewModel.availableStrategies.collectAsState()
                                val isLoadingPreview by technicalAnalysisViewModel.isLoadingPreview.collectAsState()

                                LaunchedEffect(Unit) {
                                    if (viewModel.selectedCandidate.value == null) {
                                        tradeSetupConfig?.let { config ->
                                            config.symbol?.let { sym ->
                                                viewModel.restoreSession(sym, config.strategyId)
                                            }
                                        }
                                    }
                                }

                                if (candidate == null) {
                                    androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                                        if (candidatesError != null) {
                                            Text(candidatesError ?: "Market candidate unavailable", color = MaterialTheme.colorScheme.error)
                                        } else {
                                            androidx.compose.material3.CircularProgressIndicator(color = com.cryptopulse.app.ui.theme.CyanPrimary)
                                        }
                                    }
                                    return@composable
                                }

                                val initialStrategy = selectedStrategyId ?: tradeSetupConfig?.strategyId ?: "ScalperV2"

                                LaunchedEffect(candidate.pairName, initialStrategy) {
                                    val cleanConfig = technicalAnalysisViewModel.sanitizeConfigForStrategy(
                                        baseConfig = tradeSetupConfig,
                                        targetStrategy = viewedStrategyId,
                                        symbol = candidate.pairName
                                    )
                                    technicalAnalysisViewModel.loadPreviewAnalysis(candidate.pairName, viewedStrategyId, cleanConfig)
                                }

                                val previewError by technicalAnalysisViewModel.previewError.collectAsState()
                                val isBotActive by technicalAnalysisViewModel.isBotActive.collectAsState()
                                val committedStrategyId by technicalAnalysisViewModel.committedStrategyId.collectAsState()
                                val isActivating by technicalAnalysisViewModel.isActivating.collectAsState()
                                val activationError by technicalAnalysisViewModel.activationError.collectAsState()

                                TechnicalAnalysisScreen(
                                    candidate = candidate,
                                    analysisState = analysisState,
                                    tradeSetupConfig = tradeSetupConfig,
                                    availableStrategies = availableStrategies,
                                    viewedStrategyId = viewedStrategyId,
                                    selectedStrategyId = selectedStrategyId ?: initialStrategy,
                                    isBotActive = isBotActive,
                                    committedStrategyId = committedStrategyId,
                                    isLoading = isLoadingPreview,
                                    isActivating = isActivating,
                                    previewError = previewError,
                                    activationError = activationError,
                                    onClearActivationError = { technicalAnalysisViewModel.clearActivationError() },
                                    onSelectStrategy = { newId ->
                                        technicalAnalysisViewModel.selectStrategyForViewing(newId, candidate.pairName)
                                    },
                                    onUseStrategy = { stratToUse ->
                                        technicalAnalysisViewModel.useStrategy(stratToUse)
                                    },
                                    onCommitStrategy = { strategyToCommit ->
                                        val targetSymbols = candidates.map { it.pairName }
                                        if (targetSymbols.isNotEmpty()) {
                                            technicalAnalysisViewModel.activateBot(
                                                symbols = targetSymbols,
                                                strategy = strategyToCommit,
                                                config = tradeSetupConfig,
                                                onSuccess = {
                                                    com.cryptopulse.app.service.BackgroundMonitoringService.startService(applicationContext)
                                                }
                                            )
                                        } else {
                                            android.util.Log.w("MainActivity", "Cannot commit strategy: affordable candidate list is empty.")
                                        }
                                    },
                                    onDeactivateBot = {
                                        technicalAnalysisViewModel.stopBot {
                                            com.cryptopulse.app.service.BackgroundMonitoringService.stopService(applicationContext)
                                        }
                                    },
                                    onBack = { navController.popBackStack() },
                                    onExecuteTrade = {
                                        technicalAnalysisViewModel.triggerTradeAlert(analysisState?.symbol, applicationContext)
                                    },
                                    onRetry = {
                                        technicalAnalysisViewModel.selectStrategyForViewing(viewedStrategyId, candidate.pairName)
                                    },
                                    onLogout = performLogout
                                )
                            }

                            composable("trade_alert") { backStackEntry ->
                                val parentEntry = remember(backStackEntry) {
                                    navController.getBackStackEntry("authenticated_flow")
                                }
                                val viewModel = hiltViewModel<ExchangeViewModel>(parentEntry)
                                val alert by viewModel.pendingAlert.collectAsState(initial = null)
                                val candidate by viewModel.selectedCandidate.collectAsState(initial = null)

                                data class TradeMath(
                                    val entryPrice: Double,
                                    val stopLossPrice: Double,
                                    val takeProfitPrice: Double,
                                    val signalPrice: Double,
                                    val targetEntryPrice: Double?,
                                    val positionSize: Double,
                                    val calculatedPnl: Double
                                )
                                
                                val math = remember(alert, candidate) {
                                    val ep = (alert?.get("entryPrice") as? Double) ?: (alert?.get("signalPrice") as? Double) ?: candidate?.currentMarketPrice ?: 0.0
                                    val sl = (alert?.get("stopLoss") as? Double) ?: 0.0
                                    val tp = (alert?.get("takeProfit") as? Double) ?: 0.0
                                    val sp = (alert?.get("signalPrice") as? Double) ?: ep
                                    val tep = (alert?.get("targetEntryPrice") as? Double)
                                    val ps = (alert?.get("positionSize") as? Double) ?: 0.0
                                    
                                    val refPrice = tep ?: sp
                                    val q = if (refPrice > 0.0) ps / refPrice else 0.0
                                    val pnl = (alert?.get("estimatedPnl") as? Double) ?: (if (q > 0.0) kotlin.math.abs(tp - sp) * q else 0.0)
                                    TradeMath(ep, sl, tp, sp, tep, ps, pnl)
                                }

                                val alertCandidate = alert?.let { a ->
                                    val rawSymbol = (a["symbol"] as? String) ?: "UNKNOWN"
                                    val cleanSymbol = rawSymbol.replace("/USDT", "").replace("USDT", "")
                                    val pairName = if (rawSymbol.contains("/")) rawSymbol else if (cleanSymbol.isNotBlank()) "$cleanSymbol/USDT" else "UNKNOWN/USDT"
                                    val ep = (a["entryPrice"] as? Double) ?: (a["signalPrice"] as? Double) ?: 0.0
                                    com.cryptopulse.app.ui.screens.MarketCandidate(
                                        rank = 1,
                                        symbol = cleanSymbol,
                                        pairName = pairName,
                                        coinName = cleanSymbol,
                                        currentMarketPrice = ep,
                                        tradeSide = (a["side"] as? String) ?: "BUY"
                                    )
                                }
                                val marketCandidate = alertCandidate ?: candidate

                                LaunchedEffect(marketCandidate) {
                                    if (marketCandidate != null && candidate != marketCandidate) {
                                        viewModel.selectCandidate(marketCandidate)
                                    }
                                }

                                if (marketCandidate == null) {
                                    androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                                        Text("Market candidate unavailable", color = MaterialTheme.colorScheme.error)
                                    }
                                    return@composable
                                }
                                TradeAlertScreen(
                                    onBack = { navController.popBackStack() },
                                    onTradeExecuted = {
                                        navController.navigate("market_candidates") {
                                            popUpTo("market_candidates") { inclusive = false }
                                        }
                                    },
                                    candidate = marketCandidate,
                                    entryPrice = math.entryPrice,
                                    stopLossPrice = math.stopLossPrice,
                                    takeProfitPrice = math.takeProfitPrice,
                                    estimatedPnl = math.calculatedPnl,
                                    signalPrice = math.signalPrice,
                                    targetEntryPrice = math.targetEntryPrice,
                                    tradeAmountUsdt = math.positionSize,
                                    viewModel = viewModel
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

    private fun handleIncomingAlertIntent(intent: Intent?) {
        if (intent?.getBooleanExtra("extra_alert", false) == true) {
            val entryPrice = intent.getDoubleExtra("alert_entry_price", 0.0)
            val stopLoss = intent.getDoubleExtra("alert_stop_loss", 0.0)
            val takeProfit = intent.getDoubleExtra("alert_take_profit", 0.0)
            val estimatedPnl = intent.getDoubleExtra("alert_estimated_pnl", 0.0)
            val signalPrice = intent.getDoubleExtra("alert_signal_price", entryPrice)
            val targetEntryPrice = if (intent.hasExtra("alert_target_entry_price")) intent.getDoubleExtra("alert_target_entry_price", 0.0) else null
            val positionSize = if (intent.hasExtra("alert_position_size")) intent.getDoubleExtra("alert_position_size", 0.0) else null
            val alertId = intent.getStringExtra("alert_id")
            val symbol = intent.getStringExtra("alert_symbol") ?: "UNKNOWN"
            if (entryPrice > 0 && alertId != null) {
                val alert = mutableMapOf<String, Any>(
                    "id" to alertId,
                    "symbol" to symbol,
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
                tradeAlertManager.onNewAlertReceived(alert)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingAlertIntent(intent)
    }
}



