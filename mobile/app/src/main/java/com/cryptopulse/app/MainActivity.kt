package com.cryptopulse.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import com.cryptopulse.app.ui.theme.CryptoPulseTheme
import dagger.hilt.android.AndroidEntryPoint

import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.cryptopulse.app.ui.auth.AuthViewModel
import com.cryptopulse.app.ui.auth.OtpScreen
import com.cryptopulse.app.ui.auth.RegisterScreen
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import com.cryptopulse.app.data.local.TokenManager
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
                    
                    // Simple routing based on token presence
                    val startDestination = if (token.isNullOrEmpty()) "register" else "home"
                    
                    // Need to give DataStore a moment to load, otherwise it might flash login
                    // In a production app, use a Splash screen state to wait for tokenFlow
                    
                    NavHost(navController = navController, startDestination = startDestination) {
                        composable("register") {
                            val viewModel = hiltViewModel<AuthViewModel>()
                            RegisterScreen(
                                viewModel = viewModel,
                                onNavigateToOtp = {
                                    navController.navigate("otp") {
                                        popUpTo("register") { inclusive = true }
                                    }
                                }
                            )
                        }
                        composable("otp") {
                            val viewModel = hiltViewModel<AuthViewModel>()
                            OtpScreen(
                                viewModel = viewModel,
                                onAuthSuccess = {
                                    navController.navigate("home") {
                                        popUpTo("otp") { inclusive = true }
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

import androidx.compose.ui.unit.dp

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
