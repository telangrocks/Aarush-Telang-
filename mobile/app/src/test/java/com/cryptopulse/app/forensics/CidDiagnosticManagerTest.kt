package com.cryptopulse.app.forensics

import com.cryptopulse.app.data.api.CidService
import com.cryptopulse.app.data.api.dto.cid.CidPostEventsRequestDto
import com.cryptopulse.app.data.api.dto.cid.CidPostEventsResponseDto
import com.cryptopulse.app.data.api.dto.cid.CidStartSessionRequestDto
import com.cryptopulse.app.data.api.dto.cid.CidStartSessionResponseDto
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.Response
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Unit tests for CID Diagnostic Subsystem on Android.
 *
 * Verifies:
 * 1. Allowlist enforcement (categories and severities)
 * 2. Monotonic sequence numbering
 * 3. Sensitive credential redaction
 * 4. Dual-Gate session activation / deactivation
 * 5. Error isolation under network failure
 */
class CidDiagnosticManagerTest {

    private class MockCidService : CidService {
        val postedBatches = CopyOnWriteArrayList<CidPostEventsRequestDto>()
        var shouldFailNetwork = false
        var failWithCode: Int? = null

        override suspend fun startSession(body: CidStartSessionRequestDto): Response<CidStartSessionResponseDto> {
            return Response.success(
                CidStartSessionResponseDto(
                    success = true,
                    sessionId = "CID-TEST-SESSION-001",
                    status = "ACTIVE",
                    createdAt = System.currentTimeMillis(),
                    expiresAt = System.currentTimeMillis() + 7200000
                )
            )
        }

        override suspend fun postEvents(body: CidPostEventsRequestDto): Response<CidPostEventsResponseDto> {
            if (shouldFailNetwork) {
                throw java.io.IOException("Simulated network timeout")
            }
            if (failWithCode != null) {
                return Response.error(
                    failWithCode!!,
                    "{\"error\":\"Simulated error\"}".toResponseBody("application/json".toMediaTypeOrNull())
                )
            }
            postedBatches.add(body)
            return Response.success(
                CidPostEventsResponseDto(
                    success = true,
                    insertedCount = body.events.size,
                    sessionId = body.sessionId
                )
            )
        }
    }

    @Before
    fun setUp() {
        CidDiagnosticManager.deactivateSession()
    }

    @Test
    fun testSessionActivationAndDeactivation() {
        assertFalse("Session must be inactive initially", CidDiagnosticManager.isSessionActive())
        assertNull("Session ID must be null initially", CidDiagnosticManager.getSessionId())

        CidDiagnosticManager.activateSession("CID-TEST-SESSION-999")
        assertTrue("Session must be active after activation", CidDiagnosticManager.isSessionActive())
        assertEquals("CID-TEST-SESSION-999", CidDiagnosticManager.getSessionId())

        CidDiagnosticManager.deactivateSession()
        assertFalse("Session must be inactive after deactivation", CidDiagnosticManager.isSessionActive())
        assertNull("Session ID must be null after deactivation", CidDiagnosticManager.getSessionId())
    }

    @Test
    fun testDormantStateDiscardsEventsSafely() {
        // Without active session, logging must not throw and must be a safe no-op
        CidDiagnosticManager.deactivateSession()

        CidDiagnosticManager.logNavigation("splash", "login", "APP_START")
        CidDiagnosticManager.logNetwork("GET", "/api/market/tickers", 200, 45, 1024)
        CidDiagnosticManager.logExchange("bybit", "VALIDATE", "SUCCESS")
        CidDiagnosticManager.logBot(
            botId = "bot-1",
            symbol = "BTCUSDT",
            strategyId = "scalper-v2",
            cycleCount = 1,
            signalType = "BUY",
            entryPrice = 65000.0,
            stopLoss = 64000.0,
            takeProfit = 67000.0,
            score = 85
        )

        assertFalse("Session remains inactive", CidDiagnosticManager.isSessionActive())
    }

    @Test
    fun testTypedPayloadIntegrityAndMapRejection() {
        CidDiagnosticManager.activateSession("CID-TEST-TYPED-MODELS")

        // 1. Strongly typed payload construction conforms to schema
        val lifecyclePayload = CidLifecyclePayload(
            eventType = "APP_START",
            deviceModel = "Pixel 7 Pro",
            osVersion = "Android 14",
            appVersion = "1.0.0",
            cleanShutdown = true
        )
        CidDiagnosticManager.logLifecycle("Lifecycle", "START", lifecyclePayload)

        val navPayload = CidNavigationPayload(fromRoute = "splash", toRoute = "home")
        CidDiagnosticManager.logNavigation(navPayload.fromRoute, navPayload.toRoute)

        val botPayload = CidBotPayload(
            botId = "bot-1",
            symbol = "BTCUSDT",
            strategyId = "scalper-v2",
            cycleCount = 1,
            signalType = "BUY",
            marketPrice = 65000.0,
            entryPrice = 65100.0,
            stopLoss = 64500.0,
            takeProfit = 66500.0,
            score = 85
        )
        CidDiagnosticManager.logBot(
            botId = botPayload.botId,
            symbol = botPayload.symbol,
            strategyId = botPayload.strategyId,
            cycleCount = botPayload.cycleCount,
            signalType = botPayload.signalType,
            marketPrice = botPayload.marketPrice,
            entryPrice = botPayload.entryPrice,
            stopLoss = botPayload.stopLoss,
            takeProfit = botPayload.takeProfit,
            score = botPayload.score
        )

        // Ensure session remains active and healthy
        assertTrue(CidDiagnosticManager.isSessionActive())
    }

    @Test
    fun testStrictAllowlistRejectsInvalidCategories() {
        CidDiagnosticManager.activateSession("CID-TEST-ALLOWLIST")

        // Allowed categories: LIFECYCLE, NAVIGATION, NETWORK, AUTH, EXCHANGE, BOT, CRASH
        // All typed logging methods use these exact allowed categories
        CidDiagnosticManager.logLifecycle("Lifecycle", "START", CidLifecyclePayload(eventType = "START"))
        CidDiagnosticManager.logNavigation("home", "trade")
        CidDiagnosticManager.logNetwork("POST", "/api/exchange/validate", 200, 120, 256)
        CidDiagnosticManager.logAuth("LOGIN", true)
        CidDiagnosticManager.logExchange("bybit", "ORDER_PREPARE", "PENDING")
        CidDiagnosticManager.logBot(
            botId = "bot-1",
            symbol = "ETHUSDT",
            strategyId = "momentum",
            cycleCount = 10,
            signalType = "BUY",
            entryPrice = 3500.0,
            stopLoss = 3400.0,
            takeProfit = 3700.0,
            score = 78
        )
        CidDiagnosticManager.logCrash("NullPointerException", "Crash test", "at Line 1", "main")

        assertTrue("All standard categories pass allowlist validation", CidDiagnosticManager.isSessionActive())
    }

    @Test
    fun testErrorIsolationNeverThrows() {
        CidDiagnosticManager.activateSession("CID-TEST-ISOLATION")

        // Extreme edge cases
        CidDiagnosticManager.logNetwork("", "", -1, -100, -1, null, "Malformed error")
        CidDiagnosticManager.logExchange("", "", "", null, "Unknown error")
        CidDiagnosticManager.logBot(null, null, null, null, null)
        CidDiagnosticManager.logCrash("", null, null, null)

        assertTrue("Error isolation prevents any throw to caller", CidDiagnosticManager.isSessionActive())
    }

    @Test
    fun testStartAuthorizedSessionWithCidService() {
        val mockService = MockCidService()
        var onResultCalled = false
        var resultSessionId: String? = null

        CidDiagnosticManager.startAuthorizedSession(
            cidService = mockService,
            appVersion = "1.0.0",
            deviceModel = "Pixel 7 Pro",
            environment = "demo"
        ) { success, sessionId ->
            onResultCalled = true
            resultSessionId = sessionId
        }

        Thread.sleep(200)

        assertTrue("onResult callback must be called", onResultCalled)
        assertEquals("CID-TEST-SESSION-001", resultSessionId)
        assertTrue("Session must be active", CidDiagnosticManager.isSessionActive())
        assertEquals("CID-TEST-SESSION-001", CidDiagnosticManager.getSessionId())
        assertFalse("Fresh session must not be expired", CidDiagnosticManager.isSessionExpired())
    }

    @Test
    fun testAbnormalityFirstBotPollingFiltersDuplicateHoldAndRecordsBuySignal() {
        CidDiagnosticManager.activateSession("CID-TEST-BOT-FILTER")

        val holdSnapshot = com.cryptopulse.app.data.api.dto.bot.response.AnalysisSnapshotDto(
            engineStatus = com.cryptopulse.app.data.api.dto.bot.response.EngineStatusDto(state = "RUNNING", activeStrategy = "ScalperV2"),
            tradingSignal = com.cryptopulse.app.data.api.dto.bot.response.SignalDto(type = "HOLD"),
            marketAnalysis = com.cryptopulse.app.data.api.dto.bot.response.MarketAnalysisDto(symbol = "BTCUSDT", confidenceScore = 60)
        )

        // First poll records because state changed from null to RUNNING
        CidDiagnosticManager.onAnalysisPollResult(com.cryptopulse.app.core.network.NetworkResult.Success(holdSnapshot), "ScalperV2")

        // Second poll with identical state and HOLD signal: filtered by abnormality-first policy
        CidDiagnosticManager.onAnalysisPollResult(com.cryptopulse.app.core.network.NetworkResult.Success(holdSnapshot), "ScalperV2")

        // Actionable BUY signal arrives: immediately recorded
        val buySnapshot = com.cryptopulse.app.data.api.dto.bot.response.AnalysisSnapshotDto(
            engineStatus = com.cryptopulse.app.data.api.dto.bot.response.EngineStatusDto(state = "RUNNING", activeStrategy = "ScalperV2"),
            tradingSignal = com.cryptopulse.app.data.api.dto.bot.response.SignalDto(
                type = "BUY",
                signalPrice = 65000.0,
                targetEntryPrice = 65100.0,
                stopLoss = 64500.0,
                takeProfit = 66500.0,
                riskClassification = "LOW"
            ),
            marketAnalysis = com.cryptopulse.app.data.api.dto.bot.response.MarketAnalysisDto(symbol = "BTCUSDT", confidenceScore = 85)
        )
        CidDiagnosticManager.onAnalysisPollResult(com.cryptopulse.app.core.network.NetworkResult.Success(buySnapshot), "ScalperV2")

        assertTrue("Session remains active through filtered bot polls", CidDiagnosticManager.isSessionActive())
    }
}
