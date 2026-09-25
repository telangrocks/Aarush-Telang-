package com.cryptopulse.app.forensics

import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Log
import com.cryptopulse.app.BuildConfig
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.CidService
import com.cryptopulse.app.data.api.dto.bot.response.AnalysisSnapshotDto
import com.cryptopulse.app.data.api.dto.cid.CidStartSessionRequestDto
import com.cryptopulse.app.data.local.TokenManager
import com.cryptopulse.app.data.local.TokenState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

enum class SessionState {
    NO_SESSION,
    SESSION_STARTING,
    ACTIVE,
    PAUSED
}

/**
 * Continuous Investigation & Diagnostics (CID) Coordinator for CryptoPulse Mobile.
 *
 * Provides backend-accessible diagnostics for physical Android device testing.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * 1. Passive observer only: never modifies trading logic, strategy execution, order routing,
 *    or exchange parameters.
 * 2. Zero Bybit order semantics alteration: does NOT modify Bybit orderLinkId, clientOrderId,
 *    order payloads, or exchange interfaces.
 * 3. Strict allowlist enforcement: only explicitly defined categories and typed payloads.
 * 4. Financial privacy: never logs total net worth, raw exchange balances, or wallet arrays.
 * 5. Dual-Gate activation:
 *    - DEBUG builds: active automatically.
 *    - RELEASE builds: dormant until authorized server session started.
 * 6. Error isolation: all operations fail-safe.
 */
object CidDiagnosticManager {

    private const val TAG = "CidDiagnosticManager"

    private val ALLOWED_CATEGORIES = setOf(
        "LIFECYCLE",
        "NAVIGATION",
        "NETWORK",
        "AUTH",
        "EXCHANGE",
        "BOT",
        "CRASH"
    )

    private val FORBIDDEN_KEY_PATTERNS = setOf(
        "apikey", "apisecret", "apipassphrase", "password", "confirmpassword",
        "accesstoken", "refreshtoken", "authorization", "pin", "recoverycode",
        "privatekey", "seedphrase", "secretkey", "x-bapi-api-key", "x-bapi-sign"
    )

    private var application: Application? = null
    private var cidService: CidService? = null
    private var tokenManager: TokenManager? = null
    private var networkDispatcher: CidNetworkDispatcher? = null
    private var crashHandler: ForensicCrashHandler? = null
    private var lifecycleObserver: ForensicLifecycleObserver? = null

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var currentActivationJob: kotlinx.coroutines.Job? = null
    private val sequenceNumber = AtomicLong(0L)
    private val currentSessionId = AtomicReference<String?>(null)
    private val isSessionActive = AtomicBoolean(false)
    private val sessionExpiresAt = AtomicLong(0L)
    private val sessionState = AtomicReference<SessionState>(SessionState.NO_SESSION)
    private val activationLock = Mutex()
    private val preSessionBuffer = mutableListOf<CidEventDto>()

    private val lastObservedState = AtomicReference<String?>(null)
    private val lastObservedSignal = AtomicReference<String?>(null)
    private val lastPollLogTimestamp = AtomicLong(0L)

    private val isoDateFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)

    @Synchronized
    fun initialize(
        app: Application,
        cidService: CidService? = null,
        tokenManager: TokenManager? = null
    ) {
        if (application != null) {
            if (cidService != null) setCidService(cidService, tokenManager)
            return
        }
        application = app
        val service = cidService ?: createFallbackCidService(app)
        this.cidService = service
        this.tokenManager = tokenManager

        val dispatcher = CidNetworkDispatcher(app, service)
        networkDispatcher = dispatcher

        // If TokenManager is provided, observe tokenFlow to start authorized sessions
        if (tokenManager != null) {
            observeTokenManager(tokenManager)
        } else {
            startAuthorizedSession()
        }

        // Install Crash Handler with synchronous crash capture
        val diskWriter = ForensicDiskWriter(app)
        diskWriter.start()

        val ch = ForensicCrashHandler(diskWriter) { fatalException ->
            val seq = sequenceNumber.incrementAndGet()
            val crashPayload = CidCrashPayload(
                exceptionClass = fatalException.javaClass.name,
                message = fatalException.message ?: "No message",
                stackTraceTop = fatalException.stackTrace.take(5).joinToString("\n"),
                threadName = Thread.currentThread().name
            )
            val crashEvent = CidEventDto(
                seq = seq,
                timestamp = System.currentTimeMillis(),
                category = "CRASH",
                component = "AndroidRuntime",
                eventName = "FATAL_EXCEPTION",
                severity = "CRITICAL",
                payload = crashPayload
            )
            dispatcher.writeEmergencyCrashSync(crashEvent)
        }
        ch.install()
        crashHandler = ch

        // Install Lifecycle Observer
        val lo = ForensicLifecycleObserver(app) { eventType, details ->
            val payload = CidLifecyclePayload(
                eventType = eventType,
                deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}",
                osVersion = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
                appVersion = BuildConfig.VERSION_NAME,
                cleanShutdown = details["clean_shutdown"] as? Boolean,
                lastHeartbeatTimestamp = details["last_heartbeat_timestamp"] as? Long,
                gapDurationMs = details["gap_duration_ms"] as? Long,
                reason = details["reason"] as? String,
                packageName = details["package_name"] as? String,
                pid = details["pid"] as? Int
            )
            logLifecycle("AndroidLifecycle", eventType, payload, if (eventType == "APP_RESTART_UNCLEAN") CidSeverity.WARN else CidSeverity.INFO)
        }
        lo.register()
        lifecycleObserver = lo

        Log.i(TAG, "[CID] Continuous Investigation & Diagnostics initialized.")
    }

    private fun observeTokenManager(tm: TokenManager) {
        scope.launch {
            tm.tokenFlow.collect { tokenState ->
                when (tokenState) {
                    is TokenState.Authenticated -> {
                        val session = currentSessionId.get()
                        val expired = isSessionExpired()
                        if (session.isNullOrEmpty() || expired || !isSessionActive.get()) {
                            Log.i(TAG, "[CID] User authenticated. Starting authorized session with remote D1...")
                            resumeSession()
                        } else {
                            resumeSession()
                        }
                    }
                    is TokenState.Unauthenticated -> {
                        if (isSessionActive.get()) {
                            Log.i(TAG, "[CID] User unauthenticated. Pausing active session.")
                            pauseSession()
                        }
                    }
                    else -> {}
                }
            }
        }
    }

    fun setCidService(service: CidService, tm: TokenManager? = null) {
        this.cidService = service
        networkDispatcher?.setCidService(service)
        if (tm != null && this.tokenManager == null) {
            this.tokenManager = tm
            observeTokenManager(tm)
        } else if (isSessionExpired() || !isSessionActive.get()) {
            startAuthorizedSession()
        }
    }

    fun isSessionExpired(): Boolean {
        val exp = sessionExpiresAt.get()
        return exp > 0 && System.currentTimeMillis() >= (exp - 60_000L)
    }

    fun onSessionInvalidated() {
        Log.i(TAG, "[CID] Session invalidated or expired. Requesting new authorized session...")
        isSessionActive.set(false)
        sessionState.set(SessionState.NO_SESSION)
        currentSessionId.set(null)
        startAuthorizedSession()
    }

    /**
     * Activates a CID session with the given session ID under activationLock.
     */
    fun activateSession(sessionId: String, expiresAt: Long = System.currentTimeMillis() + 2 * 60 * 60 * 1000L) {
        currentSessionId.set(sessionId)
        sessionExpiresAt.set(expiresAt)
        isSessionActive.set(true)
        sessionState.set(SessionState.ACTIVE)
        currentActivationJob?.cancel()
        currentActivationJob = scope.launch {
            onSessionAuthorizationSuccess(sessionId, expiresAt)
        }
    }

    suspend fun onSessionAuthorizationSuccess(newSessionId: String, expiresAt: Long) = activationLock.withLock {
        if (sessionState.get() == SessionState.NO_SESSION) {
            return@withLock
        }
        currentSessionId.set(newSessionId)
        sessionExpiresAt.set(expiresAt)
        isSessionActive.set(true)

        val buffered = synchronized(preSessionBuffer) {
            val list = ArrayList(preSessionBuffer)
            preSessionBuffer.clear()
            list
        }

        var seq = 0L
        for (unsequenced in buffered) {
            seq++
            val sequenced = unsequenced.copy(seq = seq)
            networkDispatcher?.enqueue(sequenced)
        }

        sequenceNumber.set(seq)
        sessionState.set(SessionState.ACTIVE)
        networkDispatcher?.start(newSessionId)
        Log.i(TAG, "[CID] Session activated under lock: $newSessionId with $seq pre-session events drained.")
    }

    fun pauseSession() {
        sessionState.set(SessionState.PAUSED)
        networkDispatcher?.pause()
        Log.i(TAG, "[CID] Session paused.")
    }

    fun resumeSession() {
        networkDispatcher?.resume()
        if (currentSessionId.get() != null && !isSessionExpired()) {
            sessionState.set(SessionState.ACTIVE)
            Log.i(TAG, "[CID] Session resumed.")
        } else {
            sessionState.set(SessionState.NO_SESSION)
            startAuthorizedSession()
        }
    }

    /**
     * Deactivates the CID session.
     */
    fun deactivateSession() {
        currentActivationJob?.cancel()
        isSessionActive.set(false)
        sessionState.set(SessionState.NO_SESSION)
        currentSessionId.set(null)
        networkDispatcher?.stop()
        Log.i(TAG, "[CID] Session deactivated.")
    }

    fun isSessionActive(): Boolean = isSessionActive.get()
    fun getSessionId(): String? = currentSessionId.get()
    fun getSessionState(): SessionState = sessionState.get()

    /**
     * Requests authorization and starts a new CID session from the backend in RELEASE/DEBUG builds.
     */
    fun startAuthorizedSession(
        cidService: CidService? = this.cidService,
        appVersion: String = BuildConfig.VERSION_NAME,
        deviceModel: String = "${Build.MANUFACTURER} ${Build.MODEL}",
        environment: String = "demo",
        onResult: ((Boolean, String?) -> Unit)? = null
    ) {
        val service = cidService ?: this.cidService
        if (service == null) {
            Log.w(TAG, "[CID] Cannot start authorized session: CidService is null.")
            onResult?.invoke(false, "CidService is null")
            return
        }
        if (!sessionState.compareAndSet(SessionState.NO_SESSION, SessionState.SESSION_STARTING) &&
            !sessionState.compareAndSet(SessionState.PAUSED, SessionState.SESSION_STARTING)) {
            Log.d(TAG, "[CID] Session authorization already in progress or session active.")
            return
        }
        currentActivationJob?.cancel()
        currentActivationJob = scope.launch {
            try {
                val sanitizedDeviceModel = deviceModel.replace(Regex("[^a-zA-Z0-9 ._/-]"), "_").take(100)
                val sanitizedAppVersion = appVersion.replace(Regex("[^a-zA-Z0-9._-]"), "_").take(50)

                val response = service.startSession(
                    CidStartSessionRequestDto(
                        appVersion = sanitizedAppVersion,
                        deviceModel = sanitizedDeviceModel,
                        environment = environment
                    )
                )
                if (response.isSuccessful && response.body()?.success == true) {
                    val sessionId = response.body()?.sessionId
                    val expiresAt = response.body()?.expiresAt ?: (System.currentTimeMillis() + 2 * 60 * 60 * 1000L)
                    if (!sessionId.isNullOrEmpty()) {
                        onSessionAuthorizationSuccess(sessionId, expiresAt)
                        Log.i(TAG, "[CID] Authorized session established in D1: $sessionId (expires at $expiresAt)")
                        onResult?.invoke(true, sessionId)
                        return@launch
                    }
                }
                val code = response.code()
                val errorMsg = response.body()?.error ?: "HTTP $code"
                Log.w(TAG, "[CID] Failed to start authorized session: $errorMsg")
                sessionState.set(SessionState.NO_SESSION)
                onResult?.invoke(false, errorMsg)
            } catch (t: Throwable) {
                Log.e(TAG, "[CID] Exception starting authorized session: ${t.message}")
                sessionState.set(SessionState.NO_SESSION)
                onResult?.invoke(false, t.message)
            }
        }
    }

    // =========================================================================
    // Strictly-Typed Logging APIs
    // =========================================================================

    fun logLifecycle(
        component: String,
        eventName: String,
        payload: CidLifecyclePayload,
        severity: CidSeverity = CidSeverity.INFO
    ) {
        recordEvent("LIFECYCLE", component, eventName, severity, payload = payload)
    }

    fun logNavigation(
        fromRoute: String?,
        toRoute: String,
        trigger: String? = null
    ) {
        val payload = CidNavigationPayload(
            fromRoute = fromRoute,
            toRoute = toRoute,
            trigger = trigger
        )
        recordEvent("NAVIGATION", "NavController", "NAVIGATE_TO", CidSeverity.INFO, payload = payload)
    }

    fun logNetwork(
        method: String,
        path: String,
        statusCode: Int,
        durationMs: Long,
        contentLength: Long,
        cfRay: String? = null,
        error: String? = null,
        correlationId: String? = null
    ) {
        val payload = CidNetworkPayload(
            method = method,
            path = path,
            statusCode = statusCode,
            durationMs = durationMs,
            contentLength = contentLength,
            cfRay = cfRay,
            error = error
        )
        val severity = if (statusCode >= 500 || error != null) CidSeverity.ERROR
        else if (statusCode >= 400) CidSeverity.WARN
        else CidSeverity.INFO

        recordEvent("NETWORK", "OkHttp", "${method}_${statusCode}", severity, durationMs = durationMs, correlationId = correlationId, payload = payload)
    }

    fun logAuth(
        action: String,
        success: Boolean,
        errorCode: String? = null
    ) {
        val payload = CidAuthPayload(action = action, success = success, errorCode = errorCode)
        val severity = if (success) CidSeverity.INFO else CidSeverity.WARN
        recordEvent("AUTH", "AuthManager", action, severity, payload = payload)
    }

    fun logExchange(
        exchangeId: String,
        action: String,
        status: String,
        durationMs: Long? = null,
        errorCode: String? = null,
        orderType: String? = null
    ) {
        val payload = CidExchangePayload(
            exchangeId = exchangeId,
            action = action,
            status = status,
            durationMs = durationMs,
            errorCode = errorCode,
            orderType = orderType
        )
        val severity = if (errorCode != null) CidSeverity.ERROR else CidSeverity.INFO
        recordEvent("EXCHANGE", "ExchangeService", action, severity, durationMs = durationMs, payload = payload)
    }

    fun logBot(
        botId: String? = null,
        symbol: String? = null,
        strategyId: String? = null,
        cycleCount: Int? = null,
        signalType: String? = null,
        marketPrice: Double? = null,
        entryPrice: Double? = null,
        stopLoss: Double? = null,
        takeProfit: Double? = null,
        score: Int? = null,
        longScore: Int? = null,
        shortScore: Int? = null,
        overallLongScore: Int? = null,
        overallShortScore: Int? = null,
        confidence: Int? = null,
        riskClassification: String? = null,
        rejectionReason: String? = null,
        error: String? = null
    ) {
        val payload = CidBotPayload(
            botId = botId,
            symbol = symbol,
            strategyId = strategyId,
            cycleCount = cycleCount,
            signalType = signalType,
            marketPrice = marketPrice,
            entryPrice = entryPrice,
            stopLoss = stopLoss,
            takeProfit = takeProfit,
            score = score,
            longScore = longScore,
            shortScore = shortScore,
            overallLongScore = overallLongScore,
            overallShortScore = overallShortScore,
            confidence = confidence,
            riskClassification = riskClassification,
            rejectionReason = rejectionReason,
            error = error
        )
        val severity = if (error != null) CidSeverity.WARN else CidSeverity.INFO
        recordEvent("BOT", "BotEngine", "CYCLE_RESULT", severity, payload = payload)
    }

    fun logStrategyActivated(
        strategyId: String,
        symbol: String,
        entryPrice: Double? = null
    ) {
        val payload = CidBotPayload(
            strategyId = strategyId,
            symbol = symbol,
            entryPrice = entryPrice
        )
        recordEvent("BOT", "BotRepository", "STRATEGY_ACTIVATED", CidSeverity.INFO, payload = payload)
    }

    fun logSignalDisplayed(
        symbol: String?,
        strategyId: String?,
        signalType: String?,
        marketPrice: Double?,
        entryPrice: Double?,
        stopLoss: Double?,
        takeProfit: Double?,
        confidence: Int?
    ) {
        val payload = CidBotPayload(
            symbol = symbol,
            strategyId = strategyId,
            signalType = signalType,
            marketPrice = marketPrice,
            entryPrice = entryPrice,
            stopLoss = stopLoss,
            takeProfit = takeProfit,
            confidence = confidence
        )
        recordEvent("BOT", "TechnicalAnalysisViewModel", "SIGNAL_DISPLAYED", CidSeverity.INFO, payload = payload)
    }

    fun logAlertReceived(
        alertId: String,
        symbol: String,
        strategyId: String? = null,
        signalType: String? = null,
        entryPrice: Double? = null,
        stopLoss: Double? = null,
        takeProfit: Double? = null
    ) {
        val payload = CidBotPayload(
            symbol = symbol,
            strategyId = strategyId,
            signalType = signalType,
            entryPrice = entryPrice,
            stopLoss = stopLoss,
            takeProfit = takeProfit
        )
        recordEvent("BOT", "TradeAlertManager", "ALERT_RECEIVED", CidSeverity.INFO, correlationId = alertId, payload = payload)
    }

    fun logPopupAction(alertId: String, action: String) {
        val payload = CidLifecyclePayload(
            eventType = "POPUP_ACTION",
            reason = "action=$action, alertId=$alertId"
        )
        recordEvent("LIFECYCLE", "TradeAlertScreen", "POPUP_ACTION", CidSeverity.INFO, correlationId = alertId, payload = payload)
    }

    fun logExecutionResultReceived(
        alertId: String,
        symbol: String,
        strategyId: String,
        signalType: String,
        marketPrice: Double?,
        entryPrice: Double?,
        stopLoss: Double?,
        takeProfit: Double?,
        rejectionReason: String? = null,
        severity: CidSeverity = if (rejectionReason != null) CidSeverity.WARN else CidSeverity.INFO
    ) {
        val payload = CidBotPayload(
            symbol = symbol,
            strategyId = strategyId,
            signalType = signalType,
            marketPrice = marketPrice,
            entryPrice = entryPrice,
            stopLoss = stopLoss,
            takeProfit = takeProfit,
            rejectionReason = rejectionReason
        )
        recordEvent("BOT", "ExchangeViewModel", "EXECUTION_RESULT_RECEIVED", severity, correlationId = alertId, payload = payload)
    }

    fun logRateLimitCloudflare(
        path: String,
        method: String,
        durationMs: Long,
        contentLength: Long,
        cfRay: String?,
        retryAfter: String?
    ) {
        val retryError = if (retryAfter != null) "HTTP 429 (retry-after: $retryAfter)" else "HTTP 429"
        val payload = CidNetworkPayload(
            method = method,
            path = path,
            statusCode = 429,
            durationMs = durationMs,
            contentLength = contentLength,
            cfRay = cfRay,
            error = retryError
        )
        recordEvent("NETWORK", "ForensicNetworkInterceptor", "RATE_LIMIT_CLOUDFLARE", CidSeverity.WARN, correlationId = cfRay, payload = payload)
    }

    fun logCrash(
        exceptionClass: String,
        message: String?,
        stackTraceTop: String?,
        threadName: String?,
        fatal: Boolean = true
    ) {
        val payload = CidCrashPayload(
            exceptionClass = exceptionClass,
            message = message,
            stackTraceTop = stackTraceTop,
            threadName = threadName,
            fatal = fatal
        )
        recordEvent("CRASH", "AndroidRuntime", "FATAL_EXCEPTION", CidSeverity.CRITICAL, payload = payload, immediateFlush = true)
    }

    /**
     * Passive tap on bot polling result with abnormality-first filtering.
     */
    fun onAnalysisPollResult(
        result: NetworkResult<AnalysisSnapshotDto>,
        currentViewedStrategy: String? = null
    ) {
        try {
            when (result) {
                is NetworkResult.Success -> {
                    val dto = result.data
                    val signal = dto.tradingSignal
                    val signalType = signal?.type
                    val isActionableSignal = signalType == "BUY" || signalType == "SELL"
                    val engineState = dto.engineStatus?.state
                    val strategyId = currentViewedStrategy ?: dto.engineStatus?.activeStrategy
                    val confidence = dto.marketAnalysis?.confidenceScore
                    val reasoning = signal?.reasoning?.joinToString("; ")

                    val lastState = lastObservedState.get()
                    val lastSig = lastObservedSignal.get()
                    val now = System.currentTimeMillis()
                    val isStateChanged = engineState != null && engineState != lastState
                    val isSignalChanged = signalType != null && signalType != lastSig
                    val isHeartbeatDue = (now - lastPollLogTimestamp.get()) > 60_000L

                    if (isActionableSignal || isStateChanged || isSignalChanged || isHeartbeatDue) {
                        lastObservedState.set(engineState)
                        lastObservedSignal.set(signalType)
                        lastPollLogTimestamp.set(now)

                        val rejectionReason = if (!isActionableSignal && !reasoning.isNullOrEmpty()) reasoning else null

                        logBot(
                            botId = null,
                            symbol = dto.marketAnalysis?.symbol,
                            strategyId = strategyId,
                            cycleCount = null,
                            signalType = signalType,
                            marketPrice = signal?.signalPrice,
                            entryPrice = signal?.targetEntryPrice ?: signal?.signalPrice,
                            stopLoss = signal?.stopLoss,
                            takeProfit = signal?.takeProfit,
                            score = confidence,
                            riskClassification = signal?.riskClassification,
                            rejectionReason = rejectionReason,
                            error = null
                        )
                    }
                }
                is NetworkResult.Error -> {
                    logBot(
                        strategyId = currentViewedStrategy,
                        error = result.error.toString()
                    )
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Error recording analysis poll: ${t.message}")
        }
    }

    private fun recordEvent(
        category: String,
        component: String,
        eventName: String,
        severity: CidSeverity,
        durationMs: Long? = null,
        correlationId: String? = null,
        payload: Any? = null,
        immediateFlush: Boolean = false
    ) {
        if (isSessionActive.get() && isSessionExpired()) {
            onSessionInvalidated()
        }

        try {
            val upperCategory = category.uppercase(Locale.US)
            if (!ALLOWED_CATEGORIES.contains(upperCategory)) {
                Log.w(TAG, "[CID] Rejected event with unapproved category: $category")
                return
            }

            // Enforce typed payload models: reject arbitrary Map
            if (payload is Map<*, *>) {
                Log.e(TAG, "[CID] Security invariant violation: Arbitrary Map payloads prohibited. Must use strictly typed CID payload class.")
                return
            }

            val state = sessionState.get()
            if (state == SessionState.ACTIVE) {
                val seq = sequenceNumber.incrementAndGet()
                val event = CidEventDto(
                    seq = seq,
                    timestamp = System.currentTimeMillis(),
                    category = upperCategory,
                    component = component.take(100),
                    eventName = eventName.take(100),
                    severity = severity.name,
                    durationMs = durationMs,
                    correlationId = correlationId,
                    payload = payload
                )
                networkDispatcher?.enqueue(event, immediateFlush = immediateFlush)
            } else {
                // Buffer unsequenced event (seq = 0) during NO_SESSION or SESSION_STARTING
                val unsequencedEvent = CidEventDto(
                    seq = 0L,
                    timestamp = System.currentTimeMillis(),
                    category = upperCategory,
                    component = component.take(100),
                    eventName = eventName.take(100),
                    severity = severity.name,
                    durationMs = durationMs,
                    correlationId = correlationId,
                    payload = payload
                )
                synchronized(preSessionBuffer) {
                    if (preSessionBuffer.size >= 100) {
                        preSessionBuffer.removeAt(0)
                    }
                    preSessionBuffer.add(unsequencedEvent)
                }
                if (state == SessionState.NO_SESSION) {
                    startAuthorizedSession()
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "[CID] Error recording event: ${t.message}")
        }
    }

    private fun sanitizePayload(payload: Any?): Any? {
        if (payload == null) return null
        if (payload is Map<*, *>) {
            val sanitized = mutableMapOf<String, Any?>()
            for ((k, v) in payload) {
                val keyStr = k.toString()
                if (isForbiddenKey(keyStr)) {
                    sanitized[keyStr] = "[REDACTED]"
                } else {
                    sanitized[keyStr] = sanitizePayload(v)
                }
            }
            return sanitized
        }
        return payload
    }

    private fun isForbiddenKey(key: String): Boolean {
        val lower = key.lowercase(Locale.US).replace("_", "").replace("-", "")
        return FORBIDDEN_KEY_PATTERNS.any { lower.contains(it) }
    }

    private fun createFallbackCidService(context: Context): CidService {
        val okHttpClient = okhttp3.OkHttpClient.Builder().build()
        val retrofit = retrofit2.Retrofit.Builder()
            .baseUrl("https://crypto-pulse-backend.telangrocks.workers.dev/")
            .client(okHttpClient)
            .addConverterFactory(retrofit2.converter.gson.GsonConverterFactory.create())
            .build()
        return retrofit.create(CidService::class.java)
    }
}
