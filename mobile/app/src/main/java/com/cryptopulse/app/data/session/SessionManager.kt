package com.cryptopulse.app.data.session

import android.content.Context
import android.util.Log
import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.local.ExchangeConnectionManager
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.domain.repository.AuthRepository
import com.cryptopulse.app.domain.repository.BotRepository
import com.cryptopulse.app.domain.repository.FcmRepository
import com.cryptopulse.app.domain.repository.StrategyRepository
import com.cryptopulse.app.domain.repository.TradeSessionRepository
import com.cryptopulse.app.service.BackgroundMonitoringService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

sealed interface BackendLogoutOutcome {
    object ConfirmedSuccess : BackendLogoutOutcome
    data class ConfirmedRejection(val code: Int, val reason: String) : BackendLogoutOutcome
    data class ServerResponseIndeterminate(val code: Int?, val reason: String) : BackendLogoutOutcome
    object NetworkTimeoutIndeterminate : BackendLogoutOutcome
    data class NetworkFailureIndeterminate(val cause: Throwable) : BackendLogoutOutcome
    object SkippedPreDispatchCancellation : BackendLogoutOutcome
    object CancellationIndeterminate : BackendLogoutOutcome
    object SkippedConcurrentExecution : BackendLogoutOutcome
}

enum class FcmCleanupOutcome {
    NOT_CONFIGURED,
    SUCCESS,
    FAILED
}

data class LocalCleanupResult(
    val botDeactivationAttempted: Boolean,
    val botObservationStopped: Boolean,
    val backgroundServiceStopped: Boolean,
    val tradeSessionCleared: Boolean,
    val strategyCacheCleared: Boolean,
    val exchangeConnectionCleared: Boolean,
    val fcmCleanupOutcome: FcmCleanupOutcome,
    val tokensCleared: Boolean,
    val tokenClearException: Exception? = null
) {
    val allRequiredOperationsSucceeded: Boolean
        get() = botObservationStopped &&
                backgroundServiceStopped &&
                tradeSessionCleared &&
                strategyCacheCleared &&
                exchangeConnectionCleared &&
                tokensCleared &&
                tokenClearException == null &&
                (fcmCleanupOutcome != FcmCleanupOutcome.FAILED)
}

data class LogoutExecutionResult(
    val backendOutcome: BackendLogoutOutcome,
    val localCleanup: LocalCleanupResult
)

@Singleton
class SessionManager @Inject constructor(
    private val authRepository: AuthRepository,
    private val botRepository: BotRepository,
    private val tradeSessionRepository: TradeSessionRepository,
    private val exchangeConnectionManager: ExchangeConnectionManager,
    private val strategyRepository: StrategyRepository,
    private val tokenManager: TokenManager,
    private val dispatcherProvider: DispatcherProvider,
    private val fcmRepository: FcmRepository? = null
) {
    private val isLoggingOut = AtomicBoolean(false)

    suspend fun performLogout(context: Context): LogoutExecutionResult = withContext(dispatcherProvider.io) {
        if (!isLoggingOut.compareAndSet(false, true)) {
            return@withContext LogoutExecutionResult(
                backendOutcome = BackendLogoutOutcome.SkippedConcurrentExecution,
                localCleanup = LocalCleanupResult(
                    botDeactivationAttempted = false,
                    botObservationStopped = false,
                    backgroundServiceStopped = false,
                    tradeSessionCleared = false,
                    strategyCacheCleared = false,
                    exchangeConnectionCleared = false,
                    fcmCleanupOutcome = FcmCleanupOutcome.NOT_CONFIGURED,
                    tokensCleared = false,
                    tokenClearException = null
                )
            )
        }

        var pendingCancellation: CancellationException? = null
        var backendOutcome: BackendLogoutOutcome = BackendLogoutOutcome.SkippedPreDispatchCancellation
        var botDeactivationAttempted = false

        try {
            // 1. Best-effort backend bot deactivation (3-second timeout)
            try {
                withTimeoutOrNull(3000L) {
                    botDeactivationAttempted = true
                    val deactResult = botRepository.deactivateBot()
                    if (deactResult is NetworkResult.Error) {
                        Log.w("SessionManager", "Backend bot deactivation reported error during logout: ${deactResult.error}")
                    } else {
                        Log.i("SessionManager", "Backend bot deactivation succeeded during logout")
                    }
                } ?: run {
                    Log.w("SessionManager", "Backend bot deactivation timed out after 3000ms during logout")
                }
            } catch (e: CancellationException) {
                if (pendingCancellation == null) pendingCancellation = e
            } catch (e: Exception) {
                Log.w("SessionManager", "Exception during bot deactivation on logout", e)
            }

            // 2. Best-effort backend auth logout (10-second timeout)
            if (pendingCancellation == null && coroutineContext.isActive) {
                try {
                    val result = withTimeoutOrNull(10000L) {
                        authRepository.logout()
                    }
                    backendOutcome = when (result) {
                        null -> BackendLogoutOutcome.NetworkTimeoutIndeterminate
                        is NetworkResult.Success -> BackendLogoutOutcome.ConfirmedSuccess
                        is NetworkResult.Error -> when (val error = result.error) {
                            is NetworkError.HttpError -> when (error.code) {
                                401 -> BackendLogoutOutcome.ConfirmedRejection(401, error.message.ifBlank { "Unauthorized" })
                                else -> BackendLogoutOutcome.ServerResponseIndeterminate(error.code, error.message.ifBlank { "HTTP Error ${error.code}" })
                            }
                            is NetworkError.Unauthorized -> BackendLogoutOutcome.ConfirmedRejection(401, "Unauthorized")
                            is NetworkError.Forbidden -> BackendLogoutOutcome.ServerResponseIndeterminate(403, "Forbidden")
                            is NetworkError.NotFound -> BackendLogoutOutcome.ServerResponseIndeterminate(404, "Not Found")
                            is NetworkError.Timeout -> BackendLogoutOutcome.NetworkTimeoutIndeterminate
                            is NetworkError.Unknown -> BackendLogoutOutcome.NetworkFailureIndeterminate(error.error)
                            is NetworkError.Serialization -> BackendLogoutOutcome.ServerResponseIndeterminate(null, "Serialization error")
                        }
                    }
                } catch (e: CancellationException) {
                    pendingCancellation = e
                    backendOutcome = BackendLogoutOutcome.CancellationIndeterminate
                } catch (e: Exception) {
                    backendOutcome = BackendLogoutOutcome.NetworkFailureIndeterminate(e)
                }
            } else {
                backendOutcome = BackendLogoutOutcome.SkippedPreDispatchCancellation
            }

            // 3. Mandatory isolated local cleanup inside NonCancellable
            val localCleanup = withContext(NonCancellable) {
                var botObservationStopped = false
                try {
                    botRepository.stopObserving()
                    botObservationStopped = true
                } catch (e: Exception) {
                    Log.w("SessionManager", "Error stopping bot observation", e)
                }

                var backgroundServiceStopped = false
                try {
                    BackgroundMonitoringService.stopService(context)
                    backgroundServiceStopped = true
                } catch (e: Exception) {
                    Log.w("SessionManager", "Error stopping BackgroundMonitoringService", e)
                }

                var tradeSessionCleared = false
                try {
                    tradeSessionRepository.clearSession()
                    tradeSessionCleared = true
                } catch (e: Exception) {
                    Log.w("SessionManager", "Error clearing session trade state", e)
                }

                var strategyCacheCleared = false
                try {
                    strategyRepository.clearCache()
                    strategyCacheCleared = true
                } catch (e: Exception) {
                    Log.w("SessionManager", "Error clearing strategy cache", e)
                }

                var exchangeConnectionCleared = false
                try {
                    exchangeConnectionManager.clearConnection()
                    exchangeConnectionCleared = true
                } catch (e: Exception) {
                    Log.w("SessionManager", "Error clearing exchange connection", e)
                }

                val fcmOutcome = if (fcmRepository == null) {
                    FcmCleanupOutcome.NOT_CONFIGURED
                } else {
                    try {
                        fcmRepository.clearRegistrationState()
                        FcmCleanupOutcome.SUCCESS
                    } catch (e: Exception) {
                        Log.w("SessionManager", "Error clearing FCM registration state", e)
                        FcmCleanupOutcome.FAILED
                    }
                }

                var tokensCleared = false
                var tokenClearException: Exception? = null
                try {
                    tokenManager.clearTokens()
                    tokensCleared = true
                    Log.i("SessionManager", "Local authentication tokens wiped successfully")
                } catch (e: Exception) {
                    tokenClearException = e
                    Log.e("SessionManager", "Critical failure wiping tokens", e)
                }

                LocalCleanupResult(
                    botDeactivationAttempted = botDeactivationAttempted,
                    botObservationStopped = botObservationStopped,
                    backgroundServiceStopped = backgroundServiceStopped,
                    tradeSessionCleared = tradeSessionCleared,
                    strategyCacheCleared = strategyCacheCleared,
                    exchangeConnectionCleared = exchangeConnectionCleared,
                    fcmCleanupOutcome = fcmOutcome,
                    tokensCleared = tokensCleared,
                    tokenClearException = tokenClearException
                )
            }

            pendingCancellation?.let { throw it }

            LogoutExecutionResult(backendOutcome, localCleanup)
        } finally {
            isLoggingOut.set(false)
        }
    }
}
