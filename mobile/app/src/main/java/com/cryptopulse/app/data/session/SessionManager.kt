package com.cryptopulse.app.data.session

import android.content.Context
import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.domain.repository.AuthRepository
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.repository.StrategyRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.service.BackgroundMonitoringService
import kotlinx.coroutines.withContext
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
            // 1. Immediately halt background observation and polling
            botRepository.stopObserving()

            // 2. Stop foreground monitoring/notification service
            BackgroundMonitoringService.stopService(context)

            // 3. Clear session trade state and memory caches
            tradeSessionRepository.clearSession()
            strategyRepository.clearCache()
            exchangeConnectionManager.clearConnection()

            // 4. Notify backend of logout
            authRepository.logout()

            // 5. Final token wipe
            tokenManager.clearTokens()
        } finally {
            isLoggingOut.set(false)
        }
    }
}
