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
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.ui.auth.AuthScreen
import com.cryptopulse.app.ui.auth.AuthViewModel
import com.cryptopulse.app.ui.screens.UserOnboardingScreen
import com.cryptopulse.app.ui.screens.WelcomeScreen
import com.cryptopulse.app.ui.theme.CryptoPulseTheme
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
                    val startDestination = if (token.isNullOrEmpty()) "welcome" else "home"

                    NavHost(navController = navController, startDestination = startDestination) {
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
                                    navController.navigate("home") {
                                        popUpTo("welcome") { inclusive = true }
                                    }
                                }
                            )
                        }
                        composable("home") {
                            Greeting(name = "Crypto Pulse User! (Logged In)")
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
