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
import kotlinx.coroutines.flow.firstOrNull
import javax.inject.Inject

import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavHostController

@AndroidEntryPoint
class MainActivity : FragmentActivity() {

    private data class ValidatedAlertData(
        val alertId: String,
        val symbol: String,
        val side: String,
        val strategy: String,
        val entryPrice: Double,
        val stopLoss: Double,
        val takeProfit: Double,
        val estimatedPnl: Double,
        val positionSize: Double,
        val timestamp: Long?
    ) {
        val cleanSymbol: String
            get() = symbol.replace("/USDT", "").replace("USDT", "")

        val pairName: String
            get() = if (symbol.contains("/")) symbol else if (cleanSymbol.isNotBlank()) "$cleanSymbol/USDT" else "UNKNOWN/USDT"

        fun toAlertMap(): Map<String, Any> = buildMap {
            put("id", alertId)
            put("alertId", alertId)
            put("symbol", pairName)
            put("side", side.uppercase())
            put("strategy", strategy)
            put("entryPrice", entryPrice)
            put("signalPrice", entryPrice)
            put("stopLoss", stopLoss)
            put("takeProfit", takeProfit)
            put("estimatedPnl", estimatedPnl)
            put("positionSize", positionSize)
            put("type", "TRADE_ALERT")
            put("alertType", "TRADE_ALERT")
            timestamp?.let {
                put("timestamp", it)
                put("serverTimestamp", it)
            }
        }

        fun toMarketCandidate(): com.cryptopulse.app.ui.screens.MarketCandidate = com.cryptopulse.app.ui.screens.MarketCandidate(
            rank = 1,
            symbol = cleanSymbol,
            pairName = pairName,
            coinName = cleanSymbol,
            currentMarketPrice = entryPrice,
            tradeSide = side.uppercase()
        )
    }

    private var currentNavController: NavHostController? = null
    private var pendingValidatedAlert: ValidatedAlertData? = null
    private var lastHandledAlertId: String? = null

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
        val initialAlert = if (savedInstanceState == null) parseValidatedAlert(intent) else null
        if (savedInstanceState == null) {
            handleIncomingAlertIntent(intent)
        }
        setContent {
            CryptoPulseTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val navController = rememberNavController()
                    val tokenState by tokenManager.tokenFlow.collectAsState(initial = com.cryptopulse.app.data.local.TokenState.Uninitialized)
                    val token = (tokenState as? com.cryptopulse.app.data.local.TokenState.Authenticated)?.token

                    val isRegistered = tokenManager.isRegistrationCompletedSync()
                    val hasCachedToken = tokenManager.hasCachedTokenSync()

                    val startDestination = when {
                        initialAlert != null || pendingValidatedAlert != null -> "authenticated_flow"
                        !isRegistered -> "onboarding"
                        hasCachedToken -> "authenticated_flow"
                        else -> "auth"
                    }
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
                        navController.navigate("auth") {
                            popUpTo("authenticated_flow") {
                                inclusive = true
                            }
                        }
                    }

                    LaunchedEffect(navController) {
                        currentNavController = navController
                        navController.addOnDestinationChangedListener { _, destination, _ ->
                            android.util.Log.d("Navigation", "[DIAGNOSTIC] Destination = ${destination.route}")
                            com.cryptopulse.app.forensics.CidDiagnosticManager.logNavigation(
                                fromRoute = null,
                                toRoute = destination.route ?: "unknown",
                                trigger = "NAV_CONTROLLER"
                            )
                            pendingValidatedAlert?.let { alert ->
                                try {
                                    val parentEntry = navController.getBackStackEntry("authenticated_flow")
                                    val vm = androidx.lifecycle.ViewModelProvider(parentEntry)[ExchangeViewModel::class.java]
                                    vm.selectCandidate(alert.toMarketCandidate())
                                    vm.setPendingAlert(alert.toAlertMap())
                                    if (destination.route != "technical_analysis") {
                                        navController.navigate("technical_analysis") {
                                            popUpTo("connect_exchange") { inclusive = true }
                                        }
                                    }
                                    pendingValidatedAlert = null
                                } catch (_: Exception) {}
                            }
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
                                tradeAlertManager = tradeAlertManager,
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
                        val authStartDest = if (initialAlert != null || pendingValidatedAlert != null) "technical_analysis" else "connect_exchange"
                        navigation(startDestination = authStartDest, route = "authenticated_flow") {
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
                                val sessionConfig by tradeSessionRepository.tradeSetupConfig.collectAsState()
                                val selectedBudget = sessionConfig?.tradeValueUsdt?.takeIf { it > 0.0 }
                                
                                val selectedCandidate by viewModel.selectedCandidate.collectAsState(initial = null)
                                
                                LaunchedEffect(selectedBudget) {
                                    if (selectedBudget == null) {
                                        if (!navController.popBackStack("trade_setup", inclusive = false)) {
                                            navController.navigate("trade_setup") {
                                                popUpTo("market_candidates") { inclusive = true }
                                            }
                                        }
                                    } else {
                                        viewModel.fetchMarketCandidates(selectedBudget)
                                    }
                                }
                                
                                if (selectedBudget != null) {
                                    MarketCandidatesScreen(
                                        viewModel = viewModel,
                                        budget = selectedBudget,
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
                                    initialAlert?.let { alert ->
                                        viewModel.selectCandidate(alert.toMarketCandidate())
                                        viewModel.setPendingAlert(alert.toAlertMap())
                                    } ?: run {
                                        if (viewModel.selectedCandidate.value == null) {
                                            tradeSetupConfig?.let { config ->
                                                config.symbol?.let { sym ->
                                                    viewModel.restoreSession(sym, config.strategyId)
                                                }
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
                                    onActivateBot = {
                                        val targetSymbols = candidates.map { it.pairName }
                                        if (targetSymbols.isEmpty()) {
                                            android.util.Log.w("MainActivity", "Cannot activate autonomous bot: affordable candidate list is empty.")
                                        }
                                        technicalAnalysisViewModel.activateAutonomousBot(
                                            symbols = targetSymbols,
                                            config = tradeSetupConfig,
                                            onSuccess = {
                                                com.cryptopulse.app.service.BackgroundMonitoringService.startService(applicationContext)
                                            }
                                        )
                                    },
                                    onDeactivateBot = {
                                        technicalAnalysisViewModel.stopBot {
                                            com.cryptopulse.app.service.BackgroundMonitoringService.stopService(applicationContext)
                                        }
                                    },
                                    onBack = {
                                        if (!navController.popBackStack()) {
                                            navController.navigate("market_candidates") {
                                                popUpTo("authenticated_flow") { inclusive = false }
                                            }
                                        }
                                    },
                                    onExecuteTrade = {
                                        val parentEntry = try { navController.getBackStackEntry("authenticated_flow") } catch (_: Exception) { null }
                                        val exchangeVm = parentEntry?.let { androidx.lifecycle.ViewModelProvider(it)[ExchangeViewModel::class.java] }
                                        if (exchangeVm?.pendingAlert?.value != null) {
                                            navController.navigate("trade_alert")
                                        } else {
                                            technicalAnalysisViewModel.triggerTradeAlert(analysisState?.symbol, applicationContext)
                                        }
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
            }

            val tokenState by tokenManager.tokenFlow.collectAsState()
            LaunchedEffect(tokenState) {
                if (tokenState is com.cryptopulse.app.data.local.TokenState.Authenticated) {
                    try {
                        val fcmToken = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                            val cachedToken = tokenManager.getFcmToken()
                            if (!cachedToken.isNullOrEmpty()) {
                                cachedToken
                            } else {
                                try {
                                    val task = com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                                    val resolved = com.google.android.gms.tasks.Tasks.await(task)
                                    if (!resolved.isNullOrEmpty()) {
                                        tokenManager.saveFcmToken(resolved)
                                    }
                                    resolved
                                } catch (e: Exception) {
                                    null
                                }
                            }
                        }
                        if (!fcmToken.isNullOrEmpty()) {
                            fcmRepository.registerToken(fcmToken)
                        }
                    } catch (e: Exception) {
                        // Silently fail - FCM registration is optional and must not crash app
                    }
                }
            }
        }
    }

    private fun parseValidatedAlert(intent: Intent?): ValidatedAlertData? {
        if (intent == null) return null

        val isAlert = intent.getBooleanExtra("extra_alert", false) ||
                intent.getStringExtra("extra_alert") == "true" ||
                intent.getStringExtra("type") == "TRADE_ALERT" ||
                intent.getStringExtra("alertType") == "TRADE_ALERT"

        if (!isAlert) return null

        val alertId = intent.getStringExtra("alert_id")
            ?: intent.getStringExtra("id")
            ?: intent.getStringExtra("alertId")
            ?: intent.getStringExtra("alert_opportunity_id")
            ?: intent.getStringExtra("opportunityId")

        val symbol = intent.getStringExtra("alert_symbol")
            ?: intent.getStringExtra("symbol")

        val side = intent.getStringExtra("side")
            ?: intent.getStringExtra("alert_side")

        val strategy = intent.getStringExtra("strategy")
            ?: intent.getStringExtra("alert_strategy")
            ?: intent.getStringExtra("strategyId")

        val entryPrice = intent.getStringExtra("entryPrice")?.toDoubleOrNull()
            ?: intent.getDoubleExtra("alert_entry_price", -1.0).takeIf { it > 0.0 }
            ?: intent.getStringExtra("signalPrice")?.toDoubleOrNull()

        val stopLoss = intent.getStringExtra("stopLoss")?.toDoubleOrNull()
            ?: intent.getDoubleExtra("alert_stop_loss", -1.0).takeIf { it > 0.0 }

        val takeProfit = intent.getStringExtra("takeProfit")?.toDoubleOrNull()
            ?: intent.getDoubleExtra("alert_take_profit", -1.0).takeIf { it > 0.0 }

        val estimatedPnl = intent.getStringExtra("estimatedPnl")?.toDoubleOrNull()
            ?: intent.getDoubleExtra("alert_estimated_pnl", 0.0)

        val positionSize = intent.getStringExtra("positionSize")?.toDoubleOrNull()
            ?: intent.getDoubleExtra("alert_position_size", 0.0)

        val timestamp = intent.getStringExtra("serverTimestamp")?.toLongOrNull()
            ?: intent.getStringExtra("timestamp")?.toLongOrNull()
            ?: intent.getLongExtra("alert_timestamp", 0L).takeIf { it > 0L }

        // MANDATORY SAFETY REQUIREMENT: Never silently substitute 0.0 for execution-critical fields
        if (alertId.isNullOrBlank() ||
            symbol.isNullOrBlank() ||
            side.isNullOrBlank() || (!side.equals("BUY", ignoreCase = true) && !side.equals("SELL", ignoreCase = true)) ||
            strategy.isNullOrBlank() ||
            entryPrice == null || entryPrice <= 0.0 ||
            stopLoss == null || stopLoss <= 0.0 ||
            takeProfit == null || takeProfit <= 0.0
        ) {
            android.util.Log.w("MainActivity", "[SAFETY_GATE] Trade alert rejected: missing or invalid mandatory fields (alertId=$alertId, symbol=$symbol, side=$side, strategy=$strategy, entry=$entryPrice, SL=$stopLoss, TP=$takeProfit)")
            return null
        }

        // Stale alert validation (5-minute freshness window)
        if (timestamp != null && timestamp > 0L && (System.currentTimeMillis() - timestamp) > 300_000L) {
            android.util.Log.w("MainActivity", "[STALE_ALERT] Alert $alertId is stale (${(System.currentTimeMillis() - timestamp) / 1000}s old). Rejecting.")
            return null
        }

        // Check if alert was already handled/resolved
        if (tradeAlertManager.isAlertHandled(alertId)) {
            android.util.Log.w("MainActivity", "[DUPLICATE_ALERT] Alert $alertId is already resolved/handled. Rejecting.")
            return null
        }

        return ValidatedAlertData(
            alertId = alertId,
            symbol = symbol,
            side = side,
            strategy = strategy,
            entryPrice = entryPrice,
            stopLoss = stopLoss,
            takeProfit = takeProfit,
            estimatedPnl = estimatedPnl,
            positionSize = positionSize,
            timestamp = timestamp
        )
    }

    private fun handleIncomingAlertIntent(intent: Intent?) {
        if (intent == null) return
        val alert = parseValidatedAlert(intent)
        if (alert == null) return

        if (alert.alertId == lastHandledAlertId) {
            android.util.Log.d("MainActivity", "[DEDUP] Alert ${alert.alertId} was already processed in this activity instance.")
            return
        }
        lastHandledAlertId = alert.alertId

        // Immediate intent extra cleansing to prevent recreation loops
        intent.removeExtra("extra_alert")
        intent.removeExtra("type")
        intent.removeExtra("alertType")
        intent.removeExtra("alert_id")
        intent.removeExtra("id")
        intent.removeExtra("alertId")
        intent.removeExtra("alert_opportunity_id")
        intent.removeExtra("opportunityId")

        val alertMap = alert.toAlertMap()
        val candidate = alert.toMarketCandidate()

        tradeAlertManager.restoreAlertForViewing(alertMap)

        tradeSessionRepository.setTradeSetupConfig(
            com.cryptopulse.app.domain.models.TradeSetupConfig(
                strategyId = alert.strategy,
                symbol = alert.pairName,
                entryPrice = alert.entryPrice,
                tradeValueUsdt = alert.positionSize
            )
        )

        val nav = currentNavController
        try {
            if (nav != null) {
                val parentEntry = nav.getBackStackEntry("authenticated_flow")
                val vm = androidx.lifecycle.ViewModelProvider(parentEntry)[ExchangeViewModel::class.java]
                vm.selectCandidate(candidate)
                vm.setPendingAlert(alertMap)
                if (nav.currentDestination?.route != "technical_analysis") {
                    nav.navigate("technical_analysis") {
                        popUpTo("connect_exchange") { inclusive = true }
                    }
                }
            } else {
                pendingValidatedAlert = alert
            }
        } catch (_: Exception) {
            pendingValidatedAlert = alert
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingAlertIntent(intent)
    }
}



