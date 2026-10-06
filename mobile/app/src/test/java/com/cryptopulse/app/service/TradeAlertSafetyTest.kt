package com.cryptopulse.app.service

import com.cryptopulse.app.data.local.HandledAlertRecord
import com.cryptopulse.app.data.local.TradeAlertDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TradeAlertSafetyTest {

    private val testDispatcher = StandardTestDispatcher()
    private val testScope = TestScope(testDispatcher)

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun createTestAlert(id: String = "alert_1001", symbol: String = "BTC/USDT"): Map<String, Any> {
        return mapOf(
            "id" to id,
            "alertId" to id,
            "symbol" to symbol,
            "side" to "BUY",
            "entryPrice" to 95000.0,
            "stopLoss" to 93500.0,
            "takeProfit" to 98000.0,
            "estimatedPnl" to 300.0,
            "strategy" to "ScalperV2"
        )
    }

    // ── Test 1: Duplicate FCM delivery starts hardware at most once ───────────
    @Test
    fun testDuplicateFcmAlertStartsHardwareOnlyOnce() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alert = createTestAlert("fcm_alert_1")

        // First delivery -> fresh trigger
        manager.onNewAlertReceived(alert)
        assertEquals(TradeAlertState.VOICE_PLAYING, manager.currentState.value)
        assertEquals(1, manager.audioStartCount)
        assertEquals(1, manager.vibrationStartCount)

        // Duplicate delivery with same alertId
        manager.onNewAlertReceived(alert)
        assertEquals(TradeAlertState.VOICE_PLAYING, manager.currentState.value)
        assertEquals(1, manager.audioStartCount) // Did not start second time!
        assertEquals(1, manager.vibrationStartCount)
    }

    // ── Test 2: Poll duplicate from BackgroundMonitoringService does not re-arm ─
    @Test
    fun testPollDuplicateDoesNotRestartHardware() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alert = createTestAlert("poll_alert_2")

        manager.onNewAlertReceived(alert)
        assertEquals(1, manager.audioStartCount)

        // Simulate 30s background poll sending the same pending alert
        manager.onNewAlertReceived(alert)
        assertEquals(1, manager.audioStartCount)
        assertEquals(1, manager.vibrationStartCount)
    }

    // ── Test 3: SILENCE stops audio & vibration, releases WakeLock, keeps alert ─
    @Test
    fun testSilenceActionStopsHardwareAndPreservesAlertData() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alert = createTestAlert("silence_alert_3")

        manager.onNewAlertReceived(alert)
        assertEquals(TradeAlertState.VOICE_PLAYING, manager.currentState.value)

        // User taps SILENCE in notification drawer
        manager.silenceHardware("silence_alert_3")

        assertEquals(TradeAlertState.HARDWARE_SILENCED, manager.currentState.value)
        assertEquals(1, manager.audioStopCount)
        assertEquals(1, manager.vibrationStopCount)
        assertTrue(manager.wakeLockReleased)

        // Alert opportunity is strictly PRESERVED
        assertNotNull(manager.getActiveAlert())
        assertEquals("silence_alert_3", manager.getActiveAlert()?.get("id"))
    }

    // ── Test 4: Notification dismissal (deleteIntent) triggers same shutdown ───
    @Test
    fun testNotificationDismissalStopsHardwareAndPreservesOpportunity() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alert = createTestAlert("dismiss_swipe_4")

        manager.onNewAlertReceived(alert)
        assertEquals(TradeAlertState.VOICE_PLAYING, manager.currentState.value)

        // User swipes notification away -> ActionReceiver receives ACTION_DISMISS
        val receiver = TradeAlertActionReceiver().apply {
            tradeAlertManager = manager
        }
        receiver.handleAction(TradeAlertActionReceiver.ACTION_DISMISS, "dismiss_swipe_4")

        assertEquals(TradeAlertState.HARDWARE_SILENCED, manager.currentState.value)
        assertEquals(1, manager.audioStopCount)
        assertEquals(1, manager.vibrationStopCount)
        assertTrue(manager.wakeLockReleased)
        assertNotNull(manager.getActiveAlert())
    }

    // ── Test 5: Hardware timeout bounded to 30 seconds ─────────────────────────
    @Test
    fun testHardwareTimeoutStopsAutomaticallyAt30Seconds() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alert = createTestAlert("timeout_alert_5")

        manager.onNewAlertReceived(alert)
        assertEquals(TradeAlertState.VOICE_PLAYING, manager.currentState.value)

        // Advance virtual time by 30 seconds
        testScheduler.advanceTimeBy(TradeAlertManager.TRADE_ALERT_HARDWARE_TIMEOUT_MS)
        testScheduler.runCurrent()

        assertEquals(TradeAlertState.HARDWARE_SILENCED, manager.currentState.value)
        assertEquals(1, manager.audioStopCount)
        assertEquals(1, manager.vibrationStopCount)
        assertTrue(manager.wakeLockReleased)
        // Alert opportunity still available for user!
        assertNotNull(manager.getActiveAlert())
    }

    // ── Test 6: Idempotent shutdown (multiple calls do not double-release/crash) ─
    @Test
    fun testIdempotentSilenceShutdown() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alert = createTestAlert("idempotent_6")

        manager.onNewAlertReceived(alert)
        // Call silenceHardware 5 times in a row
        manager.silenceHardware("idempotent_6")
        manager.silenceHardware("idempotent_6")
        manager.silenceHardware("idempotent_6")
        manager.silenceHardware("idempotent_6")
        manager.silenceHardware("idempotent_6")

        assertEquals(TradeAlertState.HARDWARE_SILENCED, manager.currentState.value)
        assertNotNull(manager.getActiveAlert())
    }

    // ── Test 7: Cold start restoration does NOT start audio or vibration ────────
    @Test
    fun testColdStartRestorationDoesNotTriggerHardware() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alert = createTestAlert("cold_start_7")

        // SplashScreen calls restoreAlertForViewing instead of onNewAlertReceived
        manager.restoreAlertForViewing(alert)

        assertEquals(TradeAlertState.USER_VIEWING_ALERT, manager.currentState.value)
        assertEquals(0, manager.audioStartCount)
        assertEquals(0, manager.vibrationStartCount)
        assertEquals("cold_start_7", manager.getActiveAlert()?.get("id"))
    }

    // ── Test 8: After SILENCE, trade remains available and user can cancel/trade ─
    @Test
    fun testTradeRemainsAvailableAndCanBeDismissedOrExecutedAfterSilence() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alert = createTestAlert("trade_exec_8")

        manager.onNewAlertReceived(alert)
        manager.silenceHardware("trade_exec_8")
        assertEquals(TradeAlertState.HARDWARE_SILENCED, manager.currentState.value)

        // User navigates to screen and views it
        manager.onUserViewingAlertScreen()
        assertEquals(TradeAlertState.USER_VIEWING_ALERT, manager.currentState.value)
        assertNotNull(manager.getActiveAlert())

        // User taps CANCEL or TRADE
        manager.dismissOrExecuteAlert()
        assertEquals(TradeAlertState.IDLE, manager.currentState.value)
        assertNull(manager.getActiveAlert())
    }

    // ── Test 9: Persistent alert history suppresses hardware on app restart ─────
    @Test
    fun testProcessDeathReplayProtectionSuppressesHardware() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        // Simulate previous session where alert was silenced
        fakeDataStore.recordAlertHardwareState("replay_alert_9", "HARDWARE_SILENCED")

        // Brand new manager instance (simulating cold app process restart)
        val newProcessManager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)

        // Incoming alert with same alertId delivered after process restart
        val alert = createTestAlert("replay_alert_9")
        newProcessManager.onNewAlertReceived(alert)

        // Hardware must NOT be re-armed!
        assertEquals(0, newProcessManager.audioStartCount)
        assertEquals(0, newProcessManager.vibrationStartCount)
    }

    // ── Test 10: WakeLock bound is at most 35 seconds ────────────────────────────
    @Test
    fun testWakeLockBoundIsAtMost35Seconds() {
        assertEquals(30_000L, TradeAlertManager.TRADE_ALERT_HARDWARE_TIMEOUT_MS)
        assertEquals(35_000L, TradeAlertManager.WAKELOCK_TIMEOUT_MS)
        assertTrue(TradeAlertManager.WAKELOCK_TIMEOUT_MS <= 35_000L)
    }

    // ── Test 11: Successive alert starts fresh hardware after previous alert silenced ──
    @Test
    fun testSuccessiveAlertStartsHardwareAfterPreviousAlertSilenced() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alertA = createTestAlert("alert_A_silenced")
        val alertB = createTestAlert("alert_B_new")

        // Alert A arrives and starts hardware
        manager.onNewAlertReceived(alertA)
        assertEquals(1, manager.audioStartCount)
        assertEquals(1, manager.vibrationStartCount)

        // Alert A is silenced (e.g. user taps SILENCE or 30s timeout)
        manager.silenceHardware("alert_A_silenced")
        assertEquals(TradeAlertState.HARDWARE_SILENCED, manager.currentState.value)

        // Legitimate Alert B arrives
        manager.onNewAlertReceived(alertB)

        // Alert B MUST start audio and vibration!
        assertEquals(2, manager.audioStartCount)
        assertEquals(2, manager.vibrationStartCount)
        assertEquals(TradeAlertState.VOICE_PLAYING, manager.currentState.value)
        assertEquals("alert_B_new", manager.getActiveAlert()?.get("id"))
    }

    // ── Test 12: Active replacement transfers watchdog and old timeout cannot stop new alert ──
    @Test
    fun testActiveReplacementTransfersLifecycleAndOldWatchdogCannotStopNewAlert() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alertA = createTestAlert("alert_A_active")
        val alertB = createTestAlert("alert_B_replacing")

        // Alert A arrives and starts hardware
        manager.onNewAlertReceived(alertA)
        assertEquals(1, manager.audioStartCount)

        // Advance 10 seconds into Alert A's window
        testScheduler.advanceTimeBy(10_000L)
        testScheduler.runCurrent()
        assertEquals(TradeAlertState.VOICE_PLAYING, manager.currentState.value)

        // Alert B arrives while Alert A is actively VOICE_PLAYING
        manager.onNewAlertReceived(alertB)
        assertEquals("alert_B_replacing", manager.getActiveAlert()?.get("id"))

        // Advance another 20 seconds (30s since Alert A arrived, but only 20s since Alert B arrived!)
        testScheduler.advanceTimeBy(20_000L)
        testScheduler.runCurrent()

        // Alert A's original 30s mark has passed, but Alert B must STILL be actively playing!
        assertEquals(TradeAlertState.VOICE_PLAYING, manager.currentState.value)
        assertEquals(0, manager.audioStopCount)

        // Advance remaining 10 seconds (total 30s since Alert B arrived)
        testScheduler.advanceTimeBy(10_000L)
        testScheduler.runCurrent()

        // Now Alert B's fresh 30s watchdog has fired!
        assertEquals(TradeAlertState.HARDWARE_SILENCED, manager.currentState.value)
        assertEquals(1, manager.audioStopCount)
        assertEquals(1, manager.vibrationStopCount)
    }

    // ── Test 13: dismissOrExecuteAlert preserves semantic RESOLVED state in DataStore ──
    @Test
    fun testDismissOrExecuteAlertPreservesResolvedState() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        val manager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)
        val alert = createTestAlert("alert_resolved_test")

        manager.onNewAlertReceived(alert)
        assertEquals(TradeAlertState.VOICE_PLAYING, manager.currentState.value)

        // User executes or cancels trade
        manager.dismissOrExecuteAlert()
        testScheduler.runCurrent()

        // Manager state reset to IDLE and active alert cleared
        assertEquals(TradeAlertState.IDLE, manager.currentState.value)
        assertNull(manager.getActiveAlert())

        // Persisted state MUST be "RESOLVED", not overwritten to "HARDWARE_SILENCED"
        val history = fakeDataStore.getHandledAlertHistory()
        assertEquals("RESOLVED", history["alert_resolved_test"]?.hardwareState)
    }

    // ── Test 14: Duplicate alert suppressed after RESOLVED and after HARDWARE_SILENCED ──
    @Test
    fun testDuplicateAlertSuppressionAfterResolvedAndAfterSilenced() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        val manager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)
        val alertA = createTestAlert("alert_silenced_dup")
        val alertB = createTestAlert("alert_resolved_dup")

        // 1. Test duplicate after HARDWARE_SILENCED
        manager.onNewAlertReceived(alertA)
        manager.silenceHardware("alert_silenced_dup")
        testScheduler.runCurrent()
        val audioStartsAfterA = manager.audioStartCount

        // Duplicate of Alert A arrives
        manager.onNewAlertReceived(alertA)
        assertEquals(audioStartsAfterA, manager.audioStartCount) // No hardware restart!

        // 2. Test duplicate after RESOLVED
        manager.onNewAlertReceived(alertB)
        manager.dismissOrExecuteAlert()
        testScheduler.runCurrent()
        val audioStartsAfterB = manager.audioStartCount

        // Duplicate of Alert B arrives
        manager.onNewAlertReceived(alertB)
        assertEquals(audioStartsAfterB, manager.audioStartCount) // No hardware restart!
    }
}

// ── Testable Subclass for Pure JVM Unit Verification ──────────────────────────

class TestableTradeAlertManager(
    dataStore: TradeAlertDataStore = FakePersistentTradeAlertDataStore(),
    dispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Main
) : TradeAlertManager(dataStore, dispatcher) {

    var audioStartCount = 0
    var audioStopCount = 0
    var vibrationStartCount = 0
    var vibrationStopCount = 0
    var wakeLockReleased = false

    override fun onNewAlertReceived(alertData: Map<String, Any>) {
        val alertId = (alertData["id"] as? String) ?: (alertData["alertId"] as? String) ?: return
        if (isAlertHandled(alertId)) {
            // Suppressed duplicate
            super.onNewAlertReceived(alertData)
            return
        }
        audioStartCount++
        vibrationStartCount++
        wakeLockReleased = false
        super.onNewAlertReceived(alertData)
    }

    override fun silenceHardware(alertId: String?) {
        audioStopCount++
        vibrationStopCount++
        wakeLockReleased = true
        super.silenceHardware(alertId)
    }

    override fun dismissOrExecuteAlert() {
        audioStopCount++
        vibrationStopCount++
        wakeLockReleased = true
        super.dismissOrExecuteAlert()
    }
}

class FakePersistentTradeAlertDataStore : TradeAlertDataStore() {
    private val memoryHistory = mutableMapOf<String, HandledAlertRecord>()
    private var activeAlert: Map<String, Any>? = null

    override suspend fun recordAlertHardwareState(alertId: String, state: String) {
        memoryHistory[alertId] = HandledAlertRecord(alertId, state, System.currentTimeMillis())
    }

    override suspend fun getHandledAlertHistory(): Map<String, HandledAlertRecord> {
        return memoryHistory
    }

    override suspend fun saveActiveAlert(alertData: Map<String, Any>?) {
        activeAlert = alertData
    }

    override fun getActiveAlertFlow(): kotlinx.coroutines.flow.Flow<Map<String, Any>?> {
        return flowOf(activeAlert)
    }
}
