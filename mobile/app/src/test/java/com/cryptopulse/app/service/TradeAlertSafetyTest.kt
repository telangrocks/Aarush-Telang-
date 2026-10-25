package com.cryptopulse.app.service

import com.cryptopulse.app.data.local.HandledAlertRecord
import com.cryptopulse.app.data.local.TradeAlertDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
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

    // ── Test 15: Active alert is eligible for confirmation (not resolved) ──
    @Test
    fun testActiveAlertIsNotResolved() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        val manager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)
        val alert = createTestAlert("alert_active_1")

        manager.onNewAlertReceived(alert)
        testScheduler.runCurrent()

        assertTrue(manager.isAlertKnown("alert_active_1"))
        assertFalse("Active alert must not be marked resolved", manager.isAlertResolved("alert_active_1"))
    }

    // ── Test 16: Silenced alert remains eligible for confirmation (not resolved) ──
    @Test
    fun testSilencedAlertIsNotResolved() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        val manager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)
        val alert = createTestAlert("alert_silenced_1")

        manager.onNewAlertReceived(alert)
        manager.silenceHardware("alert_silenced_1")
        testScheduler.runCurrent()

        assertTrue(manager.isAlertKnown("alert_silenced_1"))
        assertFalse("Silenced alert must not be marked resolved", manager.isAlertResolved("alert_silenced_1"))
    }

    // ── Test 17: Dismissed or executed alert is marked resolved ──
    @Test
    fun testDismissOrExecuteMarksAlertResolved() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        val manager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)
        val alert = createTestAlert("alert_exec_1")

        manager.onNewAlertReceived(alert)
        manager.dismissOrExecuteAlert()
        testScheduler.runCurrent()

        assertTrue("Executed alert must be marked resolved", manager.isAlertResolved("alert_exec_1"))
    }

    // ── Test 18: Unrecognized alert is not resolved ──
    @Test
    fun testUnknownAlertIsNotResolved() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        val manager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)
        manager.awaitRestored()

        assertFalse("Unknown alert must not be marked resolved", manager.isAlertResolved("alert_unknown_999"))
        assertFalse("Unknown alert must not be known", manager.isAlertKnown("alert_unknown_999"))
    }

    // ── Test 19: Notification arriving while restoration is delayed cannot bypass barrier ──
    @Test
    fun testNotificationArrivingWhileRestorationDelayedCannotBypassBarrier() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        fakeDataStore.recordAlertHardwareState("alert_persisted_resolved", "RESOLVED")

        // 1. Controllable latch to hold DataStore restoration pending
        val restorationLatch = kotlinx.coroutines.CompletableDeferred<Unit>()
        fakeDataStore.restorationLatch = restorationLatch

        // Cold-start initialization starts restoreActiveAlert() which suspends on restorationLatch
        val manager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)

        // 2. Incoming notification arrives while restoration is still pending.
        // It exercises the production dispatch path (awaitRestored followed by production validateAlertData).
        var routingCompleted = false
        var validatedAlert: com.cryptopulse.app.MainActivity.ValidatedAlertData? = null

        val alertRoutingJob = launch {
            manager.awaitRestored()
            validatedAlert = com.cryptopulse.app.MainActivity.validateAlertData(
                alertId = "alert_persisted_resolved",
                symbol = "BTC/USDT",
                side = "BUY",
                strategy = "ScalperV2",
                entryPrice = 95000.0,
                stopLoss = 93000.0,
                takeProfit = 98000.0,
                timestamp = System.currentTimeMillis(),
                tradeAlertManager = manager
            )
            routingCompleted = true
        }

        // Advance test dispatcher: both restoreActiveAlert and alertRoutingJob run up to their suspension points
        testScheduler.runCurrent()

        // 3. PROVE: Alert routing CANNOT proceed while restoration is held pending
        assertFalse("Alert routing must NOT proceed before restoration completes", routingCompleted)
        assertNull("Alert must not be validated or routed before restoration completes", validatedAlert)
        assertFalse("Cache must not yet reflect resolved state while read is held", manager.isAlertResolved("alert_persisted_resolved"))

        // 4. Release the restoration latch
        restorationLatch.complete(Unit)
        testScheduler.runCurrent()

        // 5. PROVE: Routing now completes, restoration succeeded, and persisted RESOLVED alert is rejected
        assertTrue("Alert routing must proceed after restoration unblocks", routingCompleted)
        assertTrue(
            "Persisted RESOLVED alert must be marked resolved after barrier",
            manager.isAlertResolved("alert_persisted_resolved")
        )
        assertNull(
            "Persisted RESOLVED alert must be rejected by production validation gate",
            validatedAlert
        )

        alertRoutingJob.join()
    }

    // ── Test 20: Restoration failure follows safe fail-closed behavior ──
    @Test
    fun testRestorationFailureFollowsSafeBehavior() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        fakeDataStore.shouldFailRead = true

        val manager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)
        val restored = manager.awaitRestored()
        testScheduler.runCurrent()

        assertFalse("Restoration must reflect failure", restored)
        // Fail-closed safety: unverified cold-start alert rejected to prevent duplicate execution
        assertTrue(
            "Unverified cold-start alert must be treated as resolved/rejected on read failure",
            manager.isAlertResolved("unverified_cold_alert")
        )

        // However, alerts received fresh in memory during this session remain accepted
        val freshAlert = createTestAlert("fresh_live_alert")
        manager.onNewAlertReceived(freshAlert)
        testScheduler.runCurrent()
        assertFalse("Fresh in-memory alert must remain active", manager.isAlertResolved("fresh_live_alert"))
    }

    // ── Test 21: Repeated notification dismiss/execute calls are idempotent ──
    @Test
    fun testRepeatedDismissOrExecuteCallsAreIdempotent() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        val manager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)
        val alert = createTestAlert("alert_multi_tap")

        manager.onNewAlertReceived(alert)
        manager.dismissOrExecuteAlert()
        testScheduler.runCurrent()
        assertTrue(manager.isAlertResolved("alert_multi_tap"))

        // Repeated tap / execution
        manager.dismissOrExecuteAlert()
        testScheduler.runCurrent()
        assertTrue(manager.isAlertResolved("alert_multi_tap"))
        assertEquals(TradeAlertState.IDLE, manager.currentState.value)
    }

    // ── Test 22: Hardware-silenced but unresolved alert reaches UI without replaying hardware ──
    @Test
    fun testHardwareSilencedUnresolvedAlertReachesUiWithoutReplayingHardware() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alert = createTestAlert("silenced_unresolved_alert")

        // 1. Initial trigger starts hardware
        manager.onNewAlertReceived(alert)
        assertEquals(1, manager.audioStartCount)
        assertEquals(1, manager.vibrationStartCount)

        // 2. Hardware is silenced (e.g. 30s timeout or user silence action)
        manager.silenceHardware("silenced_unresolved_alert")
        assertEquals(TradeAlertState.HARDWARE_SILENCED, manager.currentState.value)

        // Track AlertBus emissions
        var busReceivedAlertId: String? = null
        val busJob = launch {
            AlertBus.alerts.collect { event ->
                busReceivedAlertId = event["id"] as? String
            }
        }

        // 3. Re-delivery or background poll while hardware is silenced
        // Must NOT restart audio or vibration, but MUST update activeAlertData and emit to AlertBus
        manager.onNewAlertReceived(alert)
        testScheduler.runCurrent()

        assertEquals("Hardware audio must NOT replay", 1, manager.audioStartCount)
        assertEquals("Hardware vibration must NOT replay", 1, manager.vibrationStartCount)
        assertNotNull("Active alert data must be present", manager.getActiveAlert())
        assertEquals("silenced_unresolved_alert", manager.getActiveAlert()?.get("id"))
        assertEquals("AlertBus must deliver the alert to UI", "silenced_unresolved_alert", busReceivedAlertId)

        busJob.cancel()
    }

    // ── Test 23: Resolved alert is not presented again ──
    @Test
    fun testResolvedAlertIsNotPresentedAgain() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val alert = createTestAlert("resolved_alert_23")

        manager.onNewAlertReceived(alert)
        manager.dismissOrExecuteAlert()
        testScheduler.runCurrent()
        assertTrue("Alert must be resolved", manager.isAlertResolved("resolved_alert_23"))

        val audioCountBefore = manager.audioStartCount
        val vibCountBefore = manager.vibrationStartCount

        // Subsequent delivery of the resolved alert
        manager.onNewAlertReceived(alert)
        testScheduler.runCurrent()

        assertEquals("Audio must not trigger for resolved alert", audioCountBefore, manager.audioStartCount)
        assertEquals("Vibration must not trigger for resolved alert", vibCountBefore, manager.vibrationStartCount)
        assertNull("Resolved alert must not be set as active", manager.getActiveAlert())
    }

    // ── Test 24: Terminal status alerts (expired, executed, filled) are ignored ──
    @Test
    fun testTerminalStatusAlertsAreSuppressed() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val expiredAlert = createTestAlert("expired_alert_24").toMutableMap().apply {
            put("status", "expired")
        }

        manager.onNewAlertReceived(expiredAlert)
        testScheduler.runCurrent()

        assertEquals("No audio for expired alert", 0, manager.audioStartCount)
        assertEquals("No vibration for expired alert", 0, manager.vibrationStartCount)
        assertNull(manager.getActiveAlert())
    }

    // ── Test 25: Multiple pending alerts handled correctly by selection logic ──
    @Test
    fun testMultiplePendingAlertsSelectsFirstUnresolvedAlert() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)

        // Alert 1 is resolved in manager
        val alert1 = createTestAlert("alert_resolved_1")
        manager.onNewAlertReceived(alert1)
        manager.dismissOrExecuteAlert()
        testScheduler.runCurrent()
        assertTrue(manager.isAlertResolved("alert_resolved_1"))

        // Alert 2 is unresolved
        val botAlert1 = com.cryptopulse.app.domain.models.BotAlert(
            id = "alert_resolved_1",
            symbol = "BTC/USDT",
            entryPrice = 50000.0,
            stopLoss = 49000.0,
            takeProfit = 52000.0,
            estimatedPnl = 2000.0,
            strategy = "ScalperV2",
            side = "BUY",
            timestamp = "2026-10-25T00:00:00Z"
        )
        val botAlert2 = com.cryptopulse.app.domain.models.BotAlert(
            id = "alert_unresolved_2",
            symbol = "ETH/USDT",
            entryPrice = 3000.0,
            stopLoss = 2900.0,
            takeProfit = 3200.0,
            estimatedPnl = 200.0,
            strategy = "Momentum",
            side = "BUY",
            timestamp = "2026-10-25T00:01:00Z"
        )

        val service = BackgroundMonitoringService().apply {
            tradeAlertManager = manager
        }

        val selected = service.selectActionableAlert(listOf(botAlert1, botAlert2))
        assertNotNull("An actionable alert must be selected", selected)
        assertEquals("Resolved alert must be skipped in favor of unresolved alert", "alert_unresolved_2", selected?.id)
    }

    // ── Test 26: Repeated polling does not duplicate presentation or execution ──
    @Test
    fun testRepeatedPollingDoesNotDuplicatePresentation() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val botAlert = com.cryptopulse.app.domain.models.BotAlert(
            id = "poll_alert_repeat",
            symbol = "BTC/USDT",
            entryPrice = 50000.0,
            stopLoss = 49000.0,
            takeProfit = 52000.0,
            estimatedPnl = 2000.0,
            strategy = "ScalperV2",
            side = "BUY",
            timestamp = "2026-10-25T00:00:00Z"
        )

        val service = BackgroundMonitoringService().apply {
            tradeAlertManager = manager
        }

        // First poll: selects and shows alert
        val firstSelected = service.selectActionableAlert(listOf(botAlert))
        assertNotNull(firstSelected)
        if (firstSelected?.id != service.lastAlertId) {
            service.lastAlertId = firstSelected?.id
            service.showTradeAlert(firstSelected!!)
        }
        testScheduler.runCurrent()
        assertEquals(1, manager.audioStartCount)
        assertEquals("poll_alert_repeat", service.lastAlertId)

        // Second poll with same alert: should NOT trigger showTradeAlert because lastAlertId matches
        val secondSelected = service.selectActionableAlert(listOf(botAlert))
        var secondShown = false
        if (secondSelected?.id != service.lastAlertId) {
            service.lastAlertId = secondSelected?.id
            service.showTradeAlert(secondSelected!!)
            secondShown = true
        }
        testScheduler.runCurrent()
        assertFalse("Repeated poll with same alert ID must NOT re-trigger showTradeAlert", secondShown)
        assertEquals("Audio start count must remain 1", 1, manager.audioStartCount)
    }

    // ── Test 27: Resolved alert followed by new alert works correctly ──
    @Test
    fun testResolvedAlertFollowedByNewAlertWorksCorrectly() = runTest(testDispatcher) {
        val manager = TestableTradeAlertManager(dispatcher = testDispatcher)
        val service = BackgroundMonitoringService().apply {
            tradeAlertManager = manager
        }

        val alert1 = com.cryptopulse.app.domain.models.BotAlert(
            id = "first_alert_27",
            symbol = "BTC/USDT",
            entryPrice = 50000.0,
            stopLoss = 49000.0,
            takeProfit = 52000.0,
            estimatedPnl = 2000.0,
            strategy = "ScalperV2",
            side = "BUY",
            timestamp = "2026-10-25T00:00:00Z"
        )

        // Present alert 1
        val sel1 = service.selectActionableAlert(listOf(alert1))
        service.lastAlertId = sel1?.id
        service.showTradeAlert(sel1!!)
        testScheduler.runCurrent()
        assertEquals(1, manager.audioStartCount)

        // User resolves alert 1
        manager.dismissOrExecuteAlert()
        testScheduler.runCurrent()
        assertTrue(manager.isAlertResolved("first_alert_27"))

        // Alert 2 arrives
        val alert2 = com.cryptopulse.app.domain.models.BotAlert(
            id = "second_alert_27",
            symbol = "ETH/USDT",
            entryPrice = 3000.0,
            stopLoss = 2900.0,
            takeProfit = 3200.0,
            estimatedPnl = 200.0,
            strategy = "Momentum",
            side = "BUY",
            timestamp = "2026-10-25T00:01:00Z"
        )

        val sel2 = service.selectActionableAlert(listOf(alert1, alert2))
        assertEquals("second_alert_27", sel2?.id)
        if (sel2?.id != service.lastAlertId) {
            service.lastAlertId = sel2?.id
            service.showTradeAlert(sel2!!)
        }
        testScheduler.runCurrent()

        assertEquals("New alert must trigger audio", 2, manager.audioStartCount)
        assertEquals("second_alert_27", manager.getActiveAlert()?.get("id"))
    }

    // ── Test 28: Service restart does not permanently suppress a valid new alert or replay stale alerts ──
    @Test
    fun testServiceRestartDoesNotReplayStaleOrSuppressNew() = runTest(testDispatcher) {
        val fakeDataStore = FakePersistentTradeAlertDataStore()
        fakeDataStore.recordAlertHardwareState("stale_persisted_resolved", "RESOLVED")

        val manager = TestableTradeAlertManager(dataStore = fakeDataStore, dispatcher = testDispatcher)
        manager.awaitRestored()
        testScheduler.runCurrent()

        // Service restarted: new instance, lastAlertId is null
        val newService = BackgroundMonitoringService().apply {
            tradeAlertManager = manager
        }
        assertNull(newService.lastAlertId)

        val staleAlert = com.cryptopulse.app.domain.models.BotAlert(
            id = "stale_persisted_resolved",
            symbol = "BTC/USDT",
            entryPrice = 50000.0,
            stopLoss = 49000.0,
            takeProfit = 52000.0,
            estimatedPnl = 2000.0,
            strategy = "ScalperV2",
            side = "BUY",
            timestamp = "2026-10-24T00:00:00Z"
        )
        val freshAlert = com.cryptopulse.app.domain.models.BotAlert(
            id = "fresh_valid_after_restart",
            symbol = "ETH/USDT",
            entryPrice = 3000.0,
            stopLoss = 2900.0,
            takeProfit = 3200.0,
            estimatedPnl = 200.0,
            strategy = "Momentum",
            side = "BUY",
            timestamp = "2026-10-25T00:02:00Z"
        )

        // Polling returns both the stale resolved alert and a fresh alert
        val selected = newService.selectActionableAlert(listOf(staleAlert, freshAlert))
        assertEquals("Stale resolved alert must NOT be replayed; fresh alert must be selected", "fresh_valid_after_restart", selected?.id)

        if (selected?.id != newService.lastAlertId) {
            newService.lastAlertId = selected?.id
            newService.showTradeAlert(selected!!)
        }
        testScheduler.runCurrent()

        assertNotNull("Fresh alert must be active", manager.getActiveAlert())
        assertEquals("fresh_valid_after_restart", manager.getActiveAlert()?.get("id"))
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
        val status = alertData["status"] as? String
        if (status == "expired" || status == "executed" || status == "filled" || isAlertResolved(alertId)) {
            super.onNewAlertReceived(alertData)
            return
        }
        if (isAlertKnown(alertId)) {
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
    var shouldFailRead: Boolean = false
    var restorationLatch: kotlinx.coroutines.CompletableDeferred<Unit>? = null

    override suspend fun recordAlertHardwareState(alertId: String, state: String) {
        memoryHistory[alertId] = HandledAlertRecord(alertId, state, System.currentTimeMillis())
    }

    override suspend fun getHandledAlertHistory(): Map<String, HandledAlertRecord> {
        restorationLatch?.await()
        if (shouldFailRead) {
            throw java.io.IOException("Simulated DataStore read failure")
        }
        return memoryHistory
    }

    override suspend fun saveActiveAlert(alertData: Map<String, Any>?) {
        activeAlert = alertData
    }

    override fun getActiveAlertFlow(): kotlinx.coroutines.flow.Flow<Map<String, Any>?> {
        return flowOf(activeAlert)
    }
}
