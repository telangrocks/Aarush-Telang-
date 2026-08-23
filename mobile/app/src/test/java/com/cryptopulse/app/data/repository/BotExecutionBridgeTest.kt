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

@OptIn(ExperimentalCoroutinesApi::class)
class BotExecutionBridgeTest {

    private val testDispatcher = UnconfinedTestDispatcher()

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
            override suspend fun executeMockTrade(request: ExecuteTradeRequestDto) = NetworkResult.Success(ExecuteTradeResponseDto(true, "Mock OK"))
            override suspend fun stopTrade() = NetworkResult.Success(StopTradeResponseDto(true, "Stopped"))
            override suspend fun getAlerts() = NetworkResult.Success(emptyList<BotAlertDto>())
            override suspend fun acknowledgeAlert(request: AcknowledgeAlertRequestDto) = NetworkResult.Success(AcknowledgeAlertResponseDto(true, "OK"))

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
}
