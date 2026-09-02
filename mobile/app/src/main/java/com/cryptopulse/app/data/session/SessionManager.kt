package com.cryptopulse.app.data.session

import android.content.Context
import android.util.Log
import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.domain.repository.AuthRepository
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.repository.StrategyRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.service.BackgroundMonitoringService
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SessionManager @Inject constructor(
    private val authRepository: AuthRepository,
    private val botRepository: BotRepository,
    private val tradeSessionRepository: TradeSessionRepository,
    private val exchangeConnectionManager: ExchangeConnectionManager,
    private val strategyRepository: StrategyRepository,
    private val tokenManager: TokenManager,
    private val dispatcherProvider: DispatcherProvider
) {
    private val isLoggingOut = AtomicBoolean(false)

    suspend fun performLogout(context: Context) = withContext(dispatcherProvider.io) {
        if (!isLoggingOut.compareAndSet(false, true)) return@withContext
        try {
            // 1. Best-effort backend bot deactivation with 3-second timeout
            try {
                withTimeoutOrNull(3000L) {
                    val deactResult = botRepository.deactivateBot()
                    if (deactResult is com.cryptopulse.app.core.network.NetworkResult.Error) {
                        Log.w("SessionManager", "Backend bot deactivation reported error during logout: ${deactResult.error}")
                    } else {
                        Log.i("SessionManager", "Backend bot deactivation succeeded during logout")
                    }
                } ?: Log.w("SessionManager", "Backend bot deactivation timed out after 3000ms during logout")
            } catch (e: Exception) {
                Log.w("SessionManager", "Exception during bot deactivation on logout", e)
            }

            // 2. Immediately halt background observation and polling
            try {
                botRepository.stopObserving()
            } catch (e: Exception) {
                Log.w("SessionManager", "Error stopping bot observation", e)
            }

            // 3. Stop foreground monitoring/notification service
            try {
                BackgroundMonitoringService.stopService(context)
            } catch (e: Exception) {
                Log.w("SessionManager", "Error stopping BackgroundMonitoringService", e)
            }

            // 4. Clear session trade state and memory caches
            try {
                tradeSessionRepository.clearSession()
                strategyRepository.clearCache()
                exchangeConnectionManager.clearConnection()
            } catch (e: Exception) {
                Log.w("SessionManager", "Error clearing session caches", e)
            }

            // 5. Notify backend of auth logout (best-effort)
            try {
                withTimeoutOrNull(2000L) {
                    authRepository.logout()
                }
            } catch (e: Exception) {
                Log.w("SessionManager", "Exception notifying backend of logout", e)
            }

            // 6. Mandatory local token wipe (guaranteed to execute)
            tokenManager.clearTokens()
            Log.i("SessionManager", "Local authentication tokens wiped successfully")
        } finally {
            isLoggingOut.set(false)
        }
    }
}
