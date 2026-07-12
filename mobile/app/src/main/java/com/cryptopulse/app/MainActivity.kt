package com.cryptopulse.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.cryptopulse.app.data.local.TokenManager
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
import com.cryptopulse.app.ui.theme.CryptoPulseTheme
import com.cryptopulse.app.ui.screens.MarketCandidate
import com.cryptopulse.app.ui.auth.ExchangeViewModel.TradeSetupState
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var tokenManager: TokenManager

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
                            SplashScreen(navController = navController, tokenManager = tokenManager)
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
                            val viewModel = hiltViewModel<ExchangeViewModel>()
                            ConnectExchangeScreen(
                                navController = navController,
                                viewModel = viewModel
                            )
                        }
                        composable("market_candidates") {
                            val viewModel = hiltViewModel<ExchangeViewModel>()
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
                            val viewModel = hiltViewModel<ExchangeViewModel>()
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
                                }
                            )
                        }
                        composable("trade_confirmation") {
                            val viewModel = hiltViewModel<ExchangeViewModel>()
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
                            val viewModel = hiltViewModel<ExchangeViewModel>()
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
                            val viewModel = hiltViewModel<ExchangeViewModel>()
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
                            TechnicalAnalysisScreen(
                                candidate = candidate,
                                strategy = strategy,
                                onBack = { navController.popBackStack() },
                                onBotToggled = { isActive ->
                                    if (isActive) {
                                        viewModel.fetchTechnicalAnalysis()
                                    }
                                }
                            )
                        }
                    }
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
