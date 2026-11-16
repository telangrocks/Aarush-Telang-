package com.cryptopulse.app.telemetry

import com.cryptopulse.app.MainActivity
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.charset.StandardCharsets

class AndroidStage9TelemetryTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private val capturedEvents = mutableListOf<Stage9TelemetryEvent>()

    @Before
    fun setUp() {
        capturedEvents.clear()
        AndroidStage9Observer.configureForTest(
            store = null,
            telemetryClient = null,
            listener = { capturedEvents.add(it) }
        )
    }

    @After
    fun tearDown() {
        AndroidStage9Observer.resetForTest()
    }

    @Test
    fun sanitizerRedactsSecretsAndPreservesFcmMessageId() {
        val event = Stage9TelemetryEvent(
            stageSeq = 1L,
            eventType = "ANDROID_FCM_RECEIVED",
            status = "PASS",
            severity = "INFO",
            alertId = "alert_sanitize_1",
            fcmMessageId = "0:1731680000123456%abcdef",
            symbol = "btc/usdt",
            strategyId = "ScalperV2",
            timeframe = "15m",
            component = "FcmService",
            message = "Authorization Bearer super.secret.jwt.token leaked?",
            outputSummary = mapOf(
                "fcmToken" to "real-device-fcm-token-123",
                "apiKey" to "bybit-key-xyz",
                "apiSecret" to "bybit-secret-xyz",
                "fcmMessageId" to "0:1731680000123456%abcdef",
                "nested" to mapOf("jwt" to "secret-jwt", "channel" to "FCM")
            )
        )

        val json = event.toJsonString()
        assertFalse(json.contains("real-device-fcm-token-123"))
        assertFalse(json.contains("bybit-key-xyz"))
        assertFalse(json.contains("bybit-secret-xyz"))
        assertFalse(json.contains("super.secret.jwt.token"))
        assertFalse(json.contains("secret-jwt"))
        assertTrue(json.contains("0:1731680000123456%abcdef"))
        assertTrue(json.contains("\"symbol\":\"BTC/USDT\""))
        assertTrue(json.contains("[REDACTED]"))
    }

    @Test
    fun queueStoreEnforces200EventCapAndBatchByteLimits() {
        val queueFile = File(tempFolder.root, AndroidTelemetryQueueStore.QUEUE_FILENAME)
        val store = AndroidTelemetryQueueStore(queueFile)

        for (i in 1..215) {
            assertTrue(
                store.enqueue(
                    Stage9TelemetryEvent(
                        stageSeq = i.toLong(),
                        eventType = "ANDROID_POLL_RECEIVED",
                        status = "PASS",
                        severity = "INFO",
                        alertId = "alert_$i",
                        symbol = "BTC/USDT",
                        strategyId = "Momentum",
                        timeframe = "5m",
                        component = "BackgroundMonitoringService",
                        message = "Poll $i"
                    )
                )
            )
        }

        assertEquals(200, store.size())

        val firstBatch = store.peekBatch()
        assertNotNull(firstBatch)
        assertEquals(25, firstBatch!!.count)
        assertTrue(firstBatch.payloadJson.toByteArray(StandardCharsets.UTF_8).size <= 28 * 1024)
        // Oldest 15 entries evicted -> alert_16 must be first in batch, alert_1 must be absent
        assertTrue(firstBatch.payloadJson.contains("\"alertId\":\"alert_16\""))
        assertFalse(firstBatch.payloadJson.contains("\"alertId\":\"alert_1\""))

        store.dropHead(25)
        assertEquals(175, store.size())
    }

    @Test
    fun clientHandlesAuthMissingRateLimitTransientFailureAndCleanDrain() = runBlocking {
        val queueFile = File(tempFolder.root, "client_queue.ndjson")
        val store = AndroidTelemetryQueueStore(queueFile)
        var currentJwt: String? = null
        var nextStatusCode = 500
        var lastRequestAuth: String? = null
        var lastRequestBody: String? = null

        val okHttp = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                lastRequestAuth = req.header("Authorization")
                val buffer = Buffer()
                req.body?.writeTo(buffer)
                lastRequestBody = buffer.readUtf8()
                Response.Builder()
                    .request(req)
                    .protocol(Protocol.HTTP_1_1)
                    .code(nextStatusCode)
                    .message("Mock")
                    .body("{}".toResponseBody("application/json".toMediaType()))
                    .build()
            }
            .build()

        val client = AndroidTelemetryClient(
            okHttpClient = okHttp,
            tokenProvider = { currentJwt },
            endpointUrl = "https://example.invalid/api/client/telemetry"
        )
        var fakeNow = 1_000_000L
        AndroidStage9Observer.configureForTest(store = store, telemetryClient = client)
        AndroidStage9Observer.clockMs = { fakeNow }

        store.enqueue(
            Stage9TelemetryEvent(
                stageSeq = 1L,
                eventType = "ANDROID_FCM_RECEIVED",
                status = "PASS",
                severity = "INFO",
                alertId = "alert_tx_1",
                fcmMessageId = "msg-1",
                symbol = "ETH/USDT",
                strategyId = "Breakout",
                timeframe = "15m",
                component = "FcmService",
                message = "Received"
            )
        )

        // Missing auth -> keep event queued without counting transient failure
        assertFalse(AndroidStage9Observer.flushPendingInternal(store, client))
        assertEquals(1, store.size())

        // 3 consecutive HTTP 500 errors (advancing clock past exponential backoff) -> records 1 ANDROID_TELEMETRY_FAILED event
        currentJwt = "test-jwt-123"
        nextStatusCode = 500
        assertFalse(AndroidStage9Observer.flushPendingInternal(store, client))
        // Before backoff expires -> skipped without hitting network
        assertFalse(AndroidStage9Observer.flushPendingInternal(store, client))
        fakeNow += 20_000L
        assertFalse(AndroidStage9Observer.flushPendingInternal(store, client))
        fakeNow += 40_000L
        assertFalse(AndroidStage9Observer.flushPendingInternal(store, client))
        assertEquals("Bearer test-jwt-123", lastRequestAuth)
        assertEquals(2, store.size()) // original event + 1 ANDROID_TELEMETRY_FAILED

        // Wait backoff & drain cleanly on HTTP 200 -> sends both original event and ANDROID_TELEMETRY_FAILED
        fakeNow += 120_000L
        nextStatusCode = 200
        assertTrue(AndroidStage9Observer.flushPendingInternal(store, client))
        assertEquals(0, store.size())
        assertTrue(lastRequestBody!!.contains("\"alertId\":\"alert_tx_1\""))
        assertTrue(lastRequestBody!!.contains("\"eventType\":\"ANDROID_TELEMETRY_FAILED\""))
    }

    @Test
    fun mainActivityValidationAndHeadsUpStatesEmitTruthfulEvents() {
        val now = System.currentTimeMillis()
        val passed = MainActivity.validateAlertData(
            alertId = "alert_valid_1",
            symbol = "SOL/USDT",
            side = "BUY",
            strategy = "MeanReversion",
            entryPrice = 150.0,
            stopLoss = 145.0,
            takeProfit = 160.0,
            timestamp = now,
            timeframe = "15m"
        )
        assertNotNull(passed)

        val rejected = MainActivity.validateAlertData(
            alertId = "alert_bad_1",
            symbol = "SOL/USDT",
            side = "BUY",
            strategy = "MeanReversion",
            entryPrice = 0.0,
            stopLoss = 145.0,
            takeProfit = 160.0,
            timestamp = now,
            timeframe = "15m"
        )
        assertNull(rejected)

        AndroidStage9Observer.recordNotificationPrecheck(
            alertId = "alert_valid_1",
            symbol = "SOL/USDT",
            strategyId = "MeanReversion",
            timeframe = "15m",
            notificationsEnabled = false,
            channelEnabled = true,
            channelImportance = 4
        )
        AndroidStage9Observer.recordNotificationPostCheck(
            alertId = "alert_valid_1",
            symbol = "SOL/USDT",
            strategyId = "MeanReversion",
            timeframe = "15m",
            notificationsEnabled = true,
            channelImportance = 4,
            notifySucceeded = true,
            activeNotificationFound = false
        )
        AndroidStage9Observer.recordPopupRendered(
            alertId = "alert_valid_1",
            symbol = "SOL/USDT",
            strategyId = "MeanReversion",
            timeframe = "15m",
            entryPrice = 150.0,
            stopLossPrice = 145.0,
            takeProfitPrice = 160.0,
            isExecutable = true,
            quantity = 0.5,
            requestedBudget = 75.0,
            effectiveNotional = 75.0
        )

        assertEquals(5, capturedEvents.size)
        assertEquals("ANDROID_ALERT_VALIDATED", capturedEvents[0].eventType)
        assertEquals("PASS", capturedEvents[0].status)
        assertEquals("ANDROID_ALERT_VALIDATED", capturedEvents[1].eventType)
        assertEquals("FAIL", capturedEvents[1].status)
        assertEquals("MISSING_MANDATORY_FIELDS", capturedEvents[1].errorCode)
        assertEquals("SUPPRESSED_PRECHECK", capturedEvents[2].outputSummary["androidOsHeadsUpState"])
        assertEquals("POST_CHECK_MISSING", capturedEvents[3].outputSummary["androidOsHeadsUpState"])
        assertEquals("ANDROID_POPUP_RENDERED", capturedEvents[4].eventType)
        assertEquals(true, capturedEvents[4].outputSummary["rendered"])
        assertEquals(Stage9TelemetryEvent.STAGE9_CONTRACT_VERSION, capturedEvents[4].contractVersion)
        val renderedJson = capturedEvents[4].toJsonString()
        assertTrue(renderedJson.contains("\"contractVersion\":${Stage9TelemetryEvent.STAGE9_CONTRACT_VERSION}"))
        assertTrue(renderedJson.contains("\"entryPrice\":150.0"))
        assertTrue(renderedJson.contains("\"stopLossPrice\":145.0"))
        assertTrue(renderedJson.contains("\"takeProfitPrice\":160.0"))
    }
}
