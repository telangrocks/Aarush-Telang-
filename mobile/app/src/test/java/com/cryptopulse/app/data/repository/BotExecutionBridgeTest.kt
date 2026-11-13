package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.bot.request.*
import com.cryptopulse.app.data.api.dto.bot.response.*
import com.cryptopulse.app.data.datasource.remote.bot.BotRemoteDataSource
import com.cryptopulse.app.data.mapper.bot.toDomain
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import com.cryptopulse.app.domain.models.TradeSetupConfig

@OptIn(ExperimentalCoroutinesApi::class)
class BotExecutionBridgeTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private val testConfig = TradeSetupConfig(strategyId = "Momentum", symbol = "BTCUSDT", entryPrice = 0.0, tradeValueUsdt = 10.0)

    private val testDispatcherProvider = object : DispatcherProvider {
        override val main: CoroutineDispatcher = testDispatcher
        override val io: CoroutineDispatcher = testDispatcher
        override val default: CoroutineDispatcher = testDispatcher
        override val unconfined: CoroutineDispatcher = testDispatcher
    }

    @Test
    fun `toDomain mapper preserves alertId and requested vs actual fill price separation`() {
        val dto = TradeExecutionStatusDto(
            success = true,
            positionId = "alert-uuid-1234",
            alertId = "alert-uuid-1234",
            orderId = "1827391823791283",
            symbol = "BTC/USDT",
            side = "BUY",
            strategy = "ScalperV2",
            exchange = "bybit",
            environment = "mainnet",
            orderType = "MARKET",
            status = "OPEN",
            entryStatus = "FILLED",
            targetEntryPrice = 95000.00,
            signalPrice = 95000.00,
            actualFillPrice = 95023.50,
            requestedQuantity = 0.0010,
            filledQuantity = 0.0010,
            remainingQuantity = 0.0000,
            stopLoss = 93500.00,
            takeProfit = 98000.00,
            slippagePercent = 0.0247,
            submittedAt = "2026-08-22T12:30:00Z",
            executedAt = "2026-08-22T12:30:02Z",
            isTerminal = true,
            isFilled = true
        )

        val domain = dto.toDomain()

        assertEquals("alert-uuid-1234", domain.positionId)
        assertEquals("alert-uuid-1234", domain.alertId)
        assertEquals("1827391823791283", domain.orderId)
        assertEquals("BTC/USDT", domain.symbol)
        assertEquals("BUY", domain.side)
        assertEquals(95000.00, domain.requestedEntryPrice, 0.0001)
        assertEquals(95023.50, domain.actualFillPrice, 0.0001)
        assertEquals(0.0010, domain.actualFilledQuantity, 0.0001)
        assertEquals(0.0247, domain.slippagePercent, 0.0001)
        assertTrue(domain.isFilled)
    }

    @Test
    fun `pollExecutionStatus emits pending then completes on terminal filled`() = runTest(testDispatcher) {
        var callCount = 0
        val fakeDataSource = object : BotRemoteDataSource {
            override suspend fun activate(request: ActivateBotRequestDto) = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun deactivate() = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun getStatus() = NetworkResult.Success(BotStatusResponseDto(true, "BTCUSDT", "ScalperV2"))
            override suspend fun getAnalysisStatus() = NetworkResult.Success(AnalysisSnapshotDto())
            override suspend fun executeTrade(alertId: String) = NetworkResult.Success(ExecuteTradeResponseDto(true, "Order accepted", alertId, alertId, "order_123"))
            override suspend fun stopTrade() = NetworkResult.Success(StopTradeResponseDto(true, "Stopped"))
            override suspend fun getAlerts() = NetworkResult.Success(emptyList<BotAlertDto>())
            override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto) = NetworkResult.Success(AcknowledgeAlertResponseDto(true, "OK"))
            override suspend fun dismissAlert(request: com.cryptopulse.app.data.api.dto.bot.request.DismissAlertRequestDto) = NetworkResult.Success(com.cryptopulse.app.data.api.dto.bot.response.DismissAlertResponseDto(true, "OK"))

            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionStatusDto> {
                callCount++
                return if (callCount == 1) {
                    NetworkResult.Success(
                        TradeExecutionStatusDto(
                            success = true,
                            positionId = positionId,
                            entryStatus = "PENDING_ENTRY",
                            isFilled = false,
                            isTerminal = false
                        )
                    )
                } else {
                    NetworkResult.Success(
                        TradeExecutionStatusDto(
                            success = true,
                            positionId = positionId,
                            orderId = "1827391823791283",
                            symbol = "BTC/USDT",
                            side = "BUY",
                            actualFillPrice = 95023.50,
                            filledQuantity = 0.0010,
                            entryStatus = "FILLED",
                            isFilled = true,
                            isTerminal = true
                        )
                    )
                }
            }
        }

        val repository = BotRepositoryImpl(fakeDataSource, testDispatcherProvider)
        val emissions = repository.pollExecutionStatus("alert-uuid-1234", timeoutMs = 5000L, pollIntervalMs = 10L).toList()

        assertEquals(2, emissions.size)
        assertFalse(emissions[0].isFilled)
        assertEquals("PENDING_ENTRY", emissions[0].entryStatus)
        assertTrue(emissions[1].isFilled)
        assertEquals("FILLED", emissions[1].entryStatus)
        assertEquals(95023.50, emissions[1].actualFillPrice, 0.0001)
        assertEquals("1827391823791283", emissions[1].orderId)
    }

    @Test
    fun `Test 1 and Test 5 - BotRepository preserves committedStrategy Momentum across polling when analysis fallback is ScalperV2`() = runTest(testDispatcher) {
        var pollResponse = AnalysisSnapshotDto(
            isActive = true,
            committedStrategy = "Momentum",
            strategyMetadata = StrategyMetadataDto(strategyId = "ScalperV2"),
            engineStatus = EngineStatusDto(
                state = "WAITING",
                activeStrategy = "Momentum",
                committedStrategy = "Momentum"
            )
        )

        val fakeDataSource = object : BotRemoteDataSource {
            override suspend fun activate(request: ActivateBotRequestDto) = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun deactivate() = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun getStatus() = NetworkResult.Success(BotStatusResponseDto(true, "BTCUSDT", "Momentum"))
            override suspend fun getAnalysisStatus() = NetworkResult.Success(pollResponse)
            override suspend fun executeTrade(alertId: String) = NetworkResult.Success(ExecuteTradeResponseDto(true, "OK"))
            override suspend fun stopTrade() = NetworkResult.Success(StopTradeResponseDto(true, "OK"))
            override suspend fun getAlerts() = NetworkResult.Success(emptyList<BotAlertDto>())
            override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto) = NetworkResult.Success(AcknowledgeAlertResponseDto(true, "OK"))
            override suspend fun dismissAlert(request: com.cryptopulse.app.data.api.dto.bot.request.DismissAlertRequestDto) = NetworkResult.Success(com.cryptopulse.app.data.api.dto.bot.response.DismissAlertResponseDto(true, "OK"))
            override suspend fun getExecutionStatus(positionId: String) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Unknown(Exception()))
        }

        val repository = BotRepositoryImpl(fakeDataSource, testDispatcherProvider)

        // 1. Activate Momentum
        repository.activateBot("BTCUSDT", "Momentum", testConfig)
        assertEquals(true, repository.isBotActive.value)
        assertEquals("Momentum", repository.committedStrategyId.value)

        // 2. Start observing (polling)
        repository.startObserving()

        // Verify state remains Momentum
        assertEquals(true, repository.isBotActive.value)
        assertEquals("Momentum", repository.committedStrategyId.value)

        // 3. Even if a poll returns analysis fallback ScalperV2 without committedStrategy field (e.g. legacy/edge-case payload),
        // client-side active bot must NEVER overwrite committed strategy!
        pollResponse = AnalysisSnapshotDto(
            isActive = true,
            strategyMetadata = StrategyMetadataDto(strategyId = "ScalperV2"),
            engineStatus = EngineStatusDto(
                state = "WAITING",
                activeStrategy = "ScalperV2"
            )
        )

        // Advance dispatcher / poll
        assertEquals("Momentum", repository.committedStrategyId.value)
        repository.stopObserving()
    }

    @Test
    fun `Test 2 - BotRepository MeanReversion remains stable and does not spontaneously change to ScalperV2`() = runTest(testDispatcher) {
        val fakeDataSource = object : BotRemoteDataSource {
            override suspend fun activate(request: ActivateBotRequestDto) = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun deactivate() = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun getStatus() = NetworkResult.Success(BotStatusResponseDto(true, "BTCUSDT", "MeanReversion"))
            override suspend fun getAnalysisStatus() = NetworkResult.Success(
                AnalysisSnapshotDto(
                    isActive = true,
                    committedStrategy = "MeanReversion",
                    strategyMetadata = StrategyMetadataDto(strategyId = "ScalperV2"),
                    engineStatus = EngineStatusDto(
                        state = "WAITING",
                        activeStrategy = "MeanReversion",
                        committedStrategy = "MeanReversion"
                    )
                )
            )
            override suspend fun executeTrade(alertId: String) = NetworkResult.Success(ExecuteTradeResponseDto(true, "OK"))
            override suspend fun stopTrade() = NetworkResult.Success(StopTradeResponseDto(true, "OK"))
            override suspend fun getAlerts() = NetworkResult.Success(emptyList<BotAlertDto>())
            override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto) = NetworkResult.Success(AcknowledgeAlertResponseDto(true, "OK"))
            override suspend fun dismissAlert(request: com.cryptopulse.app.data.api.dto.bot.request.DismissAlertRequestDto) = NetworkResult.Success(com.cryptopulse.app.data.api.dto.bot.response.DismissAlertResponseDto(true, "OK"))
            override suspend fun getExecutionStatus(positionId: String) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Unknown(Exception()))
        }

        val repository = BotRepositoryImpl(fakeDataSource, testDispatcherProvider)
        repository.activateBot("BTCUSDT", "MeanReversion", testConfig)

        assertEquals(true, repository.isBotActive.value)
        assertEquals("MeanReversion", repository.committedStrategyId.value)

        repository.startObserving()
        assertEquals("MeanReversion", repository.committedStrategyId.value)
        repository.stopObserving()
    }

    @Test
    fun `Test 3 - Explicit deactivation clears committedStrategyId and sets isBotActive to false`() = runTest(testDispatcher) {
        val fakeDataSource = object : BotRemoteDataSource {
            override suspend fun activate(request: ActivateBotRequestDto) = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun deactivate() = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun getStatus() = NetworkResult.Success(BotStatusResponseDto(false, null, null))
            override suspend fun getAnalysisStatus() = NetworkResult.Success(
                AnalysisSnapshotDto(
                    isActive = false,
                    committedStrategy = null,
                    engineStatus = EngineStatusDto(state = "STOPPED", activeStrategy = null, committedStrategy = null)
                )
            )
            override suspend fun executeTrade(alertId: String) = NetworkResult.Success(ExecuteTradeResponseDto(true, "OK"))
            override suspend fun stopTrade() = NetworkResult.Success(StopTradeResponseDto(true, "OK"))
            override suspend fun getAlerts() = NetworkResult.Success(emptyList<BotAlertDto>())
            override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto) = NetworkResult.Success(AcknowledgeAlertResponseDto(true, "OK"))
            override suspend fun dismissAlert(request: com.cryptopulse.app.data.api.dto.bot.request.DismissAlertRequestDto) = NetworkResult.Success(com.cryptopulse.app.data.api.dto.bot.response.DismissAlertResponseDto(true, "OK"))
            override suspend fun getExecutionStatus(positionId: String) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Unknown(Exception()))
        }

        val repository = BotRepositoryImpl(fakeDataSource, testDispatcherProvider)
        repository.activateBot("BTCUSDT", "Breakout", testConfig)
        assertEquals(true, repository.isBotActive.value)
        assertEquals("Breakout", repository.committedStrategyId.value)

        val deactResult = repository.deactivateBot()
        assertTrue(deactResult is NetworkResult.Success)
        assertEquals(false, repository.isBotActive.value)
        assertEquals(null, repository.committedStrategyId.value)
    }

    @Test
    fun `Test 4 - Explicit strategy switch changes committedStrategyId from MeanReversion to Momentum`() = runTest(testDispatcher) {
        val fakeDataSource = object : BotRemoteDataSource {
            override suspend fun activate(request: ActivateBotRequestDto) = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun deactivate() = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun getStatus() = NetworkResult.Success(BotStatusResponseDto(true, "BTCUSDT", "MeanReversion"))
            override suspend fun getAnalysisStatus() = NetworkResult.Success(AnalysisSnapshotDto(isActive = true, committedStrategy = "MeanReversion"))
            override suspend fun executeTrade(alertId: String) = NetworkResult.Success(ExecuteTradeResponseDto(true, "OK"))
            override suspend fun stopTrade() = NetworkResult.Success(StopTradeResponseDto(true, "OK"))
            override suspend fun getAlerts() = NetworkResult.Success(emptyList<BotAlertDto>())
            override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto) = NetworkResult.Success(AcknowledgeAlertResponseDto(true, "OK"))
            override suspend fun dismissAlert(request: com.cryptopulse.app.data.api.dto.bot.request.DismissAlertRequestDto) = NetworkResult.Success(com.cryptopulse.app.data.api.dto.bot.response.DismissAlertResponseDto(true, "OK"))
            override suspend fun getExecutionStatus(positionId: String) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Unknown(Exception()))
        }

        val repository = BotRepositoryImpl(fakeDataSource, testDispatcherProvider)
        repository.activateBot("BTCUSDT", "MeanReversion", testConfig)
        assertEquals("MeanReversion", repository.committedStrategyId.value)

        // Explicit activation switch
        repository.activateBot("BTCUSDT", "Momentum", testConfig)
        assertEquals("Momentum", repository.committedStrategyId.value)
    }
    @Test
    fun `executeTrade recovers successfully via getExecutionStatus when executeTrade times out and order is confirmed`() = runTest(testDispatcher) {
        val alertId = "test-alert-timeout-recovery"
        val fakeDataSource = object : BotRemoteDataSource {
            override suspend fun activate(request: ActivateBotRequestDto) = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun deactivate() = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun getStatus() = NetworkResult.Success(BotStatusResponseDto(true, "BTCUSDT", "ScalperV2"))
            override suspend fun getAnalysisStatus() = NetworkResult.Success(AnalysisSnapshotDto())
            override suspend fun executeTrade(alertId: String) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Timeout)
            override suspend fun executeTrade(request: ExecuteTradeRequestDto) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Timeout)
            override suspend fun stopTrade() = NetworkResult.Success(StopTradeResponseDto(true, "OK"))
            override suspend fun getAlerts() = NetworkResult.Success(emptyList<BotAlertDto>())
            override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto) = NetworkResult.Success(AcknowledgeAlertResponseDto(true, "OK"))
            override suspend fun dismissAlert(request: com.cryptopulse.app.data.api.dto.bot.request.DismissAlertRequestDto) = NetworkResult.Success(com.cryptopulse.app.data.api.dto.bot.response.DismissAlertResponseDto(true, "OK"))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionStatusDto> {
                return NetworkResult.Success(
                    TradeExecutionStatusDto(
                        success = true,
                        positionId = positionId,
                        alertId = positionId,
                        orderId = "order_recovered_bybit",
                        symbol = "NEAR/USDT",
                        side = "SELL",
                        strategy = "Breakout",
                        exchange = "bybit",
                        status = "OPEN",
                        entryStatus = "FILLED",
                        actualFillPrice = 4.566,
                        filledQuantity = 1095.0,
                        isFilled = true,
                        isTerminal = true
                    )
                )
            }
        }

        val repository = BotRepositoryImpl(fakeDataSource, testDispatcherProvider)
        val result = repository.executeTrade(alertId)

        assertTrue("Expected recovered success but got $result", result is NetworkResult.Success)
        val data = (result as NetworkResult.Success).data
        assertEquals("order_recovered_bybit", data.orderId)
        assertEquals("NEAR/USDT", data.symbol)
        assertEquals("SELL", data.side)
        assertEquals(4.566, data.actualFillPrice, 0.001)
        assertTrue(data.isFilled)
    }

    @Test
    fun `executeTrade returns HttpError when executeTrade times out and getExecutionStatus reports exchange rejection`() = runTest(testDispatcher) {
        val alertId = "test-alert-timeout-rejected"
        val fakeDataSource = object : BotRemoteDataSource {
            override suspend fun activate(request: ActivateBotRequestDto) = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun deactivate() = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun getStatus() = NetworkResult.Success(BotStatusResponseDto(true, "BTCUSDT", "ScalperV2"))
            override suspend fun getAnalysisStatus() = NetworkResult.Success(AnalysisSnapshotDto())
            override suspend fun executeTrade(alertId: String) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Timeout)
            override suspend fun executeTrade(request: ExecuteTradeRequestDto) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Timeout)
            override suspend fun stopTrade() = NetworkResult.Success(StopTradeResponseDto(true, "OK"))
            override suspend fun getAlerts() = NetworkResult.Success(emptyList<BotAlertDto>())
            override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto) = NetworkResult.Success(AcknowledgeAlertResponseDto(true, "OK"))
            override suspend fun dismissAlert(request: com.cryptopulse.app.data.api.dto.bot.request.DismissAlertRequestDto) = NetworkResult.Success(com.cryptopulse.app.data.api.dto.bot.response.DismissAlertResponseDto(true, "OK"))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionStatusDto> {
                return NetworkResult.Success(
                    TradeExecutionStatusDto(
                        success = false,
                        positionId = positionId,
                        alertId = positionId,
                        orderId = "order_rejected_id",
                        symbol = "NEAR/USDT",
                        side = "SELL",
                        status = "REJECTED",
                        entryStatus = "REJECTED",
                        message = "Insufficient balance on Bybit",
                        isFilled = false,
                        isTerminal = true
                    )
                )
            }
        }

        val repository = BotRepositoryImpl(fakeDataSource, testDispatcherProvider)
        val result = repository.executeTrade(alertId)

        assertTrue("Expected error on explicit rejection but got $result", result is NetworkResult.Error)
        val err = (result as NetworkResult.Error).error
        assertTrue(err is com.cryptopulse.app.core.error.NetworkError.HttpError)
        val httpErr = err as com.cryptopulse.app.core.error.NetworkError.HttpError
        assertEquals("Insufficient balance on Bybit", httpErr.message)
    }

    @Test
    fun `executeTrade returns original Timeout error when executeTrade times out and position is not found`() = runTest(testDispatcher) {
        val alertId = "test-alert-timeout-notfound"
        val fakeDataSource = object : BotRemoteDataSource {
            override suspend fun activate(request: ActivateBotRequestDto) = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun deactivate() = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun getStatus() = NetworkResult.Success(BotStatusResponseDto(true, "BTCUSDT", "ScalperV2"))
            override suspend fun getAnalysisStatus() = NetworkResult.Success(AnalysisSnapshotDto())
            override suspend fun executeTrade(alertId: String) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Timeout)
            override suspend fun executeTrade(request: ExecuteTradeRequestDto) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Timeout)
            override suspend fun stopTrade() = NetworkResult.Success(StopTradeResponseDto(true, "OK"))
            override suspend fun getAlerts() = NetworkResult.Success(emptyList<BotAlertDto>())
            override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto) = NetworkResult.Success(AcknowledgeAlertResponseDto(true, "OK"))
            override suspend fun dismissAlert(request: com.cryptopulse.app.data.api.dto.bot.request.DismissAlertRequestDto) = NetworkResult.Success(com.cryptopulse.app.data.api.dto.bot.response.DismissAlertResponseDto(true, "OK"))
            override suspend fun getExecutionStatus(positionId: String): NetworkResult<TradeExecutionStatusDto> {
                return NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.HttpError(404, "Position not found."))
            }
        }

        val repository = BotRepositoryImpl(fakeDataSource, testDispatcherProvider)
        val result = repository.executeTrade(alertId)

        assertTrue("Expected original Timeout error but got $result", result is NetworkResult.Error)
        assertEquals(com.cryptopulse.app.core.error.NetworkError.Timeout, (result as NetworkResult.Error).error)
    }

    @Test
    fun `activateBot rejects missing or invalid trade budget with 400 error`() = runTest(testDispatcher) {
        val fakeDataSource = object : BotRemoteDataSource {
            override suspend fun activate(request: ActivateBotRequestDto) = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun deactivate() = NetworkResult.Success(ActivateBotResponseDto(true, "OK"))
            override suspend fun getStatus() = NetworkResult.Success(BotStatusResponseDto(false, null, null))
            override suspend fun getAnalysisStatus() = NetworkResult.Success(
                AnalysisSnapshotDto(isActive = false, committedStrategy = null, engineStatus = EngineStatusDto(state = "STOPPED", activeStrategy = null, committedStrategy = null))
            )
            override suspend fun executeTrade(alertId: String) = NetworkResult.Success(ExecuteTradeResponseDto(true, "OK"))
            override suspend fun stopTrade() = NetworkResult.Success(StopTradeResponseDto(true, "OK"))
            override suspend fun getAlerts() = NetworkResult.Success(emptyList<BotAlertDto>())
            override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto) = NetworkResult.Success(AcknowledgeAlertResponseDto(true, "OK"))
            override suspend fun dismissAlert(request: com.cryptopulse.app.data.api.dto.bot.request.DismissAlertRequestDto) = NetworkResult.Success(com.cryptopulse.app.data.api.dto.bot.response.DismissAlertResponseDto(true, "OK"))
            override suspend fun getExecutionStatus(positionId: String) = NetworkResult.Error(com.cryptopulse.app.core.error.NetworkError.Unknown(Exception()))
        }
        val repository = BotRepositoryImpl(fakeDataSource, testDispatcherProvider)
        val nullResult = repository.activateBot("BTCUSDT", "Momentum", null)
        assertTrue(nullResult is NetworkResult.Error)
        val httpErr = (nullResult as NetworkResult.Error).error as com.cryptopulse.app.core.error.NetworkError.HttpError
        assertEquals(400, httpErr.code)

        val zeroConfig = TradeSetupConfig(strategyId = "Momentum", symbol = "BTCUSDT", entryPrice = 0.0, tradeValueUsdt = 0.0)
        val zeroResult = repository.activateBot("BTCUSDT", "Momentum", zeroConfig)
        assertTrue(zeroResult is NetworkResult.Error)
        val zeroHttpErr = (zeroResult as NetworkResult.Error).error as com.cryptopulse.app.core.error.NetworkError.HttpError
        assertEquals(400, zeroHttpErr.code)
    }
}
