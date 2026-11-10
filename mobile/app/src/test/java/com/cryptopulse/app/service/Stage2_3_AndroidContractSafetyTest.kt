package com.cryptopulse.app.service

import com.cryptopulse.app.MainActivity
import com.cryptopulse.app.data.api.ApiConstants
import com.cryptopulse.app.data.api.dto.bot.response.BotAlertDto
import com.cryptopulse.app.data.mapper.bot.toDomain
import com.cryptopulse.app.domain.models.BotAlert
import com.cryptopulse.app.domain.models.ExecutionUiState
import com.cryptopulse.app.ui.auth.*
import com.cryptopulse.app.ui.screens.formatIneligibilityReason
import com.cryptopulse.app.ui.screens.formatQuantity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Stage 2.3 Android Contract Safety Verification Suite
 *
 * Verifies end-to-end propagation and client-side enforcement of the Stage 2.1 / 2.2 backend alert contract:
 * - isExecutable (Boolean?)
 * - ineligibilityReason (String?)
 * - quantity (Double?)
 * - requestedBudget (Double?)
 * - effectiveNotional (Double?)
 * - estimatedPnl (Double?)
 *
 * Covers all 11 critical scenarios specified in the Stage 2.3 integration mandate.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class Stage2_3_AndroidContractSafetyTest {

    private lateinit var viewModel: ExchangeViewModel
    private lateinit var fakeBotRepo: FakeTrackingBotRepository
    private lateinit var fakeAlertManager: FakeTrackingTradeAlertManager
    private lateinit var testDispatcher: kotlinx.coroutines.test.TestDispatcher

    @Before
    fun setup() {
        testDispatcher = UnconfinedTestDispatcher()
        Dispatchers.setMain(testDispatcher)
        fakeBotRepo = FakeTrackingBotRepository()
        fakeAlertManager = FakeTrackingTradeAlertManager()

        viewModel = ExchangeViewModel(
            appContext = FakeContextMinimal(),
            exchangeRepository = FakeExchangeRepository(),
            marketRepository = FakeMarketRepositoryMinimal(),
            technicalAnalysisRepository = FakeTechnicalAnalysisRepositoryMinimal(),
            botRepository = fakeBotRepo,
            fcmRepository = FakeFcmRepositoryMinimal(),
            tokenManager = FakeTokenManagerMinimal(),
            exchangeConnectionManager = FakeExchangeConnectionManagerMinimal(),
            sessionRepository = FakeTradeSessionRepositoryMinimal(),
            tradeAlertManager = fakeAlertManager
        )
    }

    @After
    fun tearDown() {
        viewModel.stopLiveTicker()
        Dispatchers.resetMain()
    }

    // ── Scenario 1: Explicit false with missing quantity ─────────────────────
    @Test
    fun `01 - explicit false with missing quantity is blocked client-side with canonical reason`() {
        val alert = mapOf<String, Any>(
            "id" to "alert_scen_1",
            "symbol" to "BTC/USDT",
            "side" to "BUY",
            "strategy" to "ScalperV2",
            "entryPrice" to 95000.0,
            "stopLoss" to 93500.0,
            "takeProfit" to 98000.0,
            "isExecutable" to false,
            "ineligibilityReason" to "INSUFFICIENT_BUDGET"
        )
        viewModel.setPendingAlert(alert)

        viewModel.executeCurrentTrade()

        assertEquals("Zero API requests must be made for explicit false executability", 0, fakeBotRepo.executeTradeCallCount)
        assertTrue("Execution state must fail immediately", viewModel.executionState.value is ExecutionUiState.Failed)
        val error = viewModel.tradeError.value
        assertNotNull("Trade error must be set", error)
        assertTrue("Error must mention ineligibility", error!!.contains("not eligible for execution"))
        assertTrue("Error must cite canonical reason code", error.contains("INSUFFICIENT_BUDGET"))

        val noticeText = formatIneligibilityReason("INSUFFICIENT_BUDGET", true)
        assertTrue("Notice must provide user-friendly explanation", noticeText.contains("balance or allocation is insufficient"))
    }

    // ── Scenario 2: Explicit false with positive quantity ────────────────────
    @Test
    fun `02 - explicit false with positive quantity is blocked client-side without API call`() {
        val alert = mapOf<String, Any>(
            "id" to "alert_scen_2",
            "symbol" to "ETH/USDT",
            "side" to "BUY",
            "strategy" to "Momentum",
            "entryPrice" to 3000.0,
            "stopLoss" to 2900.0,
            "takeProfit" to 3200.0,
            "quantity" to 0.75,
            "isExecutable" to false,
            "ineligibilityReason" to "PORTFOLIO_EXPOSURE_EXCEEDED"
        )
        viewModel.setPendingAlert(alert)

        viewModel.executeCurrentTrade()

        assertEquals("API request must NOT be sent even if quantity is present when isExecutable is false", 0, fakeBotRepo.executeTradeCallCount)
        assertTrue("Execution state must fail", viewModel.executionState.value is ExecutionUiState.Failed)
        val error = viewModel.tradeError.value
        assertNotNull(error)
        assertTrue("Error must cite PORTFOLIO_EXPOSURE_EXCEEDED", error!!.contains("PORTFOLIO_EXPOSURE_EXCEEDED"))

        val noticeText = formatIneligibilityReason("PORTFOLIO_EXPOSURE_EXCEEDED", false)
        assertTrue("Notice must explain portfolio exposure limit", noticeText.contains("Maximum total portfolio exposure reached"))
    }

    // ── Scenario 3: Explicit true with missing quantity ──────────────────────
    @Test
    fun `03 - explicit true with missing quantity is blocked client-side`() {
        val alert = mapOf<String, Any>(
            "id" to "alert_scen_3",
            "symbol" to "SOL/USDT",
            "side" to "BUY",
            "strategy" to "Breakout",
            "entryPrice" to 150.0,
            "stopLoss" to 145.0,
            "takeProfit" to 160.0,
            "isExecutable" to true
            // quantity is deliberately omitted
        )
        viewModel.setPendingAlert(alert)

        viewModel.executeCurrentTrade()

        assertEquals("Zero API requests when quantity is missing", 0, fakeBotRepo.executeTradeCallCount)
        assertTrue("Execution state must fail", viewModel.executionState.value is ExecutionUiState.Failed)
        assertEquals("Missing or invalid approved quantity. Cannot execute trade.", viewModel.tradeError.value)
    }

    // ── Scenario 4: Legacy null executability with valid quantity ────────────
    @Test
    fun `04 - legacy null executability with valid quantity is permitted`() {
        val alert = mapOf<String, Any>(
            "id" to "alert_scen_4",
            "symbol" to "BTC/USDT",
            "side" to "BUY",
            "strategy" to "ScalperV2",
            "entryPrice" to 95000.0,
            "stopLoss" to 93500.0,
            "takeProfit" to 98000.0,
            "quantity" to 0.005
            // isExecutable omitted (null)
        )
        viewModel.setPendingAlert(alert)

        viewModel.executeCurrentTrade()

        assertEquals("Legacy alert with valid positive quantity must proceed to execution", 1, fakeBotRepo.executeTradeCallCount)
        assertEquals("alert_scen_4", fakeBotRepo.lastExecutedAlertId)
        assertTrue("Execution state must indicate success", viewModel.executionState.value is ExecutionUiState.Filled)
        assertNull("Trade error must be null on success", viewModel.tradeError.value)
    }

    // ── Scenario 5: Legacy null executability with missing quantity ──────────
    @Test
    fun `05 - legacy null executability with missing quantity is blocked client-side`() {
        val alert = mapOf<String, Any>(
            "id" to "alert_scen_5",
            "symbol" to "BTC/USDT",
            "side" to "BUY",
            "strategy" to "ScalperV2",
            "entryPrice" to 95000.0,
            "stopLoss" to 93500.0,
            "takeProfit" to 98000.0
            // isExecutable omitted and quantity omitted
        )
        viewModel.setPendingAlert(alert)

        viewModel.executeCurrentTrade()

        assertEquals("Zero API calls for legacy alert missing quantity", 0, fakeBotRepo.executeTradeCallCount)
        assertTrue("Execution state must fail", viewModel.executionState.value is ExecutionUiState.Failed)
        assertEquals("Missing or invalid approved quantity. Cannot execute trade.", viewModel.tradeError.value)
    }

    // ── Scenario 6: NaN, infinity, zero, and negative quantities ─────────────
    @Test
    fun `06 - non-finite zero and negative quantities are blocked client-side`() {
        val invalidQuantities = listOf(
            Double.NaN,
            Double.POSITIVE_INFINITY,
            Double.NEGATIVE_INFINITY,
            0.0,
            -0.005,
            -100.0
        )

        for ((index, invalidQty) in invalidQuantities.withIndex()) {
            fakeBotRepo.executeTradeCallCount = 0
            val alert = mapOf<String, Any>(
                "id" to "alert_scen_6_$index",
                "symbol" to "BTC/USDT",
                "side" to "BUY",
                "strategy" to "ScalperV2",
                "entryPrice" to 95000.0,
                "stopLoss" to 93500.0,
                "takeProfit" to 98000.0,
                "quantity" to invalidQty,
                "isExecutable" to true
            )
            viewModel.setPendingAlert(alert)

            viewModel.executeCurrentTrade()

            assertEquals("Quantity $invalidQty must never trigger execution API call", 0, fakeBotRepo.executeTradeCallCount)
            assertTrue("Execution state must fail for quantity $invalidQty", viewModel.executionState.value is ExecutionUiState.Failed)
            assertEquals("Missing or invalid approved quantity. Cannot execute trade.", viewModel.tradeError.value)
            assertEquals("Non-finite or non-positive quantity must format as neutral dash", "—", formatQuantity(invalidQty))
        }
    }

    // ── Scenario 7: Missing estimated PnL formatted as neutral dash ──────────
    @Test
    fun `07 - missing estimated PnL is null in domain model and omitted from serialization`() {
        val alert = BotAlert(
            id = "alert_scen_7",
            symbol = "BTC/USDT",
            entryPrice = 50000.0,
            stopLoss = 49000.0,
            takeProfit = 52000.0,
            estimatedPnl = null,
            strategy = "ScalperV2",
            side = "BUY",
            timestamp = "2026-11-08T00:00:00Z",
            isExecutable = false,
            ineligibilityReason = "BELOW_MIN_NOTIONAL"
        )
        assertNull("Domain estimatedPnl must be null", alert.estimatedPnl)

        val map = alert.toMap()
        assertFalse("Serialized map must omit null estimatedPnl key", map.containsKey("estimatedPnl"))

        val validated = MainActivity.ValidatedAlertData(
            alertId = "alert_scen_7",
            symbol = "BTC/USDT",
            side = "BUY",
            strategy = "ScalperV2",
            entryPrice = 50000.0,
            stopLoss = 49000.0,
            takeProfit = 52000.0,
            estimatedPnl = null,
            positionSize = 0.0,
            timestamp = System.currentTimeMillis()
        )
        assertFalse("ValidatedAlertData toAlertMap must omit null estimatedPnl", validated.toAlertMap().containsKey("estimatedPnl"))
    }

    // ── Scenario 8: Valid estimated PnL preserved across mapping ─────────────
    @Test
    fun `08 - valid estimated PnL is preserved across DTO domain and alert map`() {
        val dto = BotAlertDto(
            id = "alert_scen_8",
            symbol = "BTCUSDT",
            entryPrice = 50000.0,
            stopLoss = 49000.0,
            takeProfit = 52000.0,
            estimatedPnl = 42.50,
            strategy = "ScalperV2",
            side = "BUY",
            timestamp = "2026-11-08T00:00:00Z",
            isExecutable = true
        )
        val domain = dto.toDomain()
        assertEquals(42.50, domain.estimatedPnl!!, 0.001)

        val map = domain.toMap()
        assertEquals(42.50, (map["estimatedPnl"] as Number).toDouble(), 0.001)
    }

    // ── Scenario 9: Notification tap intent reconstruction ───────────────────
    @Test
    fun `09 - notification tap intent reconstruction preserves quantity and contract fields without wiping`() {
        val now = System.currentTimeMillis()

        // 9A: Executable Alert Intent
        val execIntent = FakeIntent(
            mutableMapOf(
                "extra_alert" to true,
                "alert_id" to "tap_exec_101",
                "alert_symbol" to "BTC/USDT",
                "alert_side" to "BUY",
                "alert_strategy" to "ScalperV2",
                "alert_entry_price" to 95000.0,
                "alert_stop_loss" to 93500.0,
                "alert_take_profit" to 98000.0,
                "alert_timestamp" to now,
                "alert_quantity" to "0.025",
                "alert_requested_budget" to "2375.0",
                "alert_effective_notional" to "2375.0",
                "alert_is_executable" to "true",
                "alert_estimated_pnl" to "75.0"
            )
        )
        val execValidated = MainActivity.parseValidatedAlert(execIntent)
        assertNotNull("Executable intent must validate", execValidated)
        assertEquals("tap_exec_101", execValidated?.alertId)
        assertEquals(0.025, execValidated?.quantity!!, 1e-6)
        assertEquals(true, execValidated?.isExecutable)
        assertEquals(2375.0, execValidated?.requestedBudget!!, 0.01)
        assertEquals(2375.0, execValidated?.effectiveNotional!!, 0.01)
        assertEquals(75.0, execValidated?.estimatedPnl!!, 0.01)
        assertNull(execValidated?.ineligibilityReason)

        // 9B: Signal-Only Alert Intent
        val signalIntent = FakeIntent(
            mutableMapOf(
                "extra_alert" to true,
                "alert_id" to "tap_signal_202",
                "alert_symbol" to "SOL/USDT",
                "alert_side" to "BUY",
                "alert_strategy" to "Breakout",
                "alert_entry_price" to 150.0,
                "alert_stop_loss" to 145.0,
                "alert_take_profit" to 160.0,
                "alert_timestamp" to now,
                "alert_is_executable" to "false",
                "alert_ineligibility_reason" to "BELOW_MIN_NOTIONAL"
            )
        )
        val signalValidated = MainActivity.parseValidatedAlert(signalIntent)
        assertNotNull("Signal-only intent must validate", signalValidated)
        assertEquals("tap_signal_202", signalValidated?.alertId)
        assertNull("Signal-only intent must have null quantity", signalValidated?.quantity)
        assertEquals(false, signalValidated?.isExecutable)
        assertEquals("BELOW_MIN_NOTIONAL", signalValidated?.ineligibilityReason)
        assertNull("Signal-only intent without pnl must have null estimatedPnl", signalValidated?.estimatedPnl)
    }

    // ── Scenario 10: DataStore / BotAlert round-trip ─────────────────────────
    @Test
    fun `10 - DataStore BotAlert serialization round-trip preserves signal-only fields`() {
        // Executable
        val execAlert = BotAlert(
            id = "alert_round_exec",
            symbol = "BTC/USDT",
            entryPrice = 95000.0,
            stopLoss = 93500.0,
            takeProfit = 98000.0,
            estimatedPnl = 150.0,
            strategy = "ScalperV2",
            side = "BUY",
            timestamp = "2026-11-08T00:00:00Z",
            isExecutable = true,
            ineligibilityReason = null,
            quantity = 0.01
        )
        val execRestored = BotAlert.fromMap(execAlert.toMap())
        assertEquals(execAlert.id, execRestored.id)
        assertEquals(true, execRestored.isExecutable)
        assertEquals(0.01, execRestored.quantity!!, 1e-6)
        assertNull(execRestored.ineligibilityReason)

        // Signal-Only
        val signalAlert = BotAlert(
            id = "alert_round_signal",
            symbol = "ETH/USDT",
            entryPrice = 3000.0,
            stopLoss = 2900.0,
            takeProfit = 3200.0,
            estimatedPnl = null,
            strategy = "Momentum",
            side = "BUY",
            timestamp = "2026-11-08T00:00:00Z",
            isExecutable = false,
            ineligibilityReason = "MIN_ORDER_QTY_UNMET",
            quantity = null
        )
        val signalRestored = BotAlert.fromMap(signalAlert.toMap())
        assertEquals(signalAlert.id, signalRestored.id)
        assertEquals(false, signalRestored.isExecutable)
        assertEquals("MIN_ORDER_QTY_UNMET", signalRestored.ineligibilityReason)
        assertNull(signalRestored.quantity)
        assertNull(signalRestored.estimatedPnl)

        // Legacy (null isExecutable)
        val legacyAlert = BotAlert(
            id = "alert_round_legacy",
            symbol = "SOL/USDT",
            entryPrice = 150.0,
            stopLoss = 145.0,
            takeProfit = 160.0,
            estimatedPnl = 20.0,
            strategy = "Breakout",
            side = "BUY",
            timestamp = "2026-11-08T00:00:00Z",
            isExecutable = null,
            ineligibilityReason = null,
            quantity = 2.0
        )
        val legacyRestored = BotAlert.fromMap(legacyAlert.toMap())
        assertEquals(legacyAlert.id, legacyRestored.id)
        assertNull(legacyRestored.isExecutable)
        assertEquals(2.0, legacyRestored.quantity!!, 1e-6)
    }

    // ── Scenario 11: Route alignment / Stage 2.6 manual route removal ────────
    @Test
    fun `11 - BOT_TRIGGER_ALERT route is removed from client`() {
        val hasBotTriggerAlert = ApiConstants::class.java.declaredFields.any { it.name == "BOT_TRIGGER_ALERT" }
        assertFalse("BOT_TRIGGER_ALERT must be removed in Stage 2.6", hasBotTriggerAlert)
    }

    // ── Helper: Fake Intent for JVM unit tests ────────────────────────────────
    private class FakeIntent(
        private val extras: MutableMap<String, Any?> = mutableMapOf()
    ) : android.content.Intent() {

        override fun getBooleanExtra(name: String, defaultValue: Boolean): Boolean {
            return (extras[name] as? Boolean)
                ?: extras[name]?.toString()?.toBooleanStrictOrNull()
                ?: defaultValue
        }

        override fun getStringExtra(name: String): String? {
            return extras[name]?.toString()
        }

        override fun getDoubleExtra(name: String, defaultValue: Double): Double {
            return (extras[name] as? Number)?.toDouble()
                ?: extras[name]?.toString()?.toDoubleOrNull()
                ?: defaultValue
        }

        override fun getLongExtra(name: String, defaultValue: Long): Long {
            return (extras[name] as? Number)?.toLong()
                ?: extras[name]?.toString()?.toLongOrNull()
                ?: defaultValue
        }

        override fun hasExtra(name: String): Boolean {
            return extras.containsKey(name)
        }

        override fun removeExtra(name: String) {
            extras.remove(name)
        }
    }
}
