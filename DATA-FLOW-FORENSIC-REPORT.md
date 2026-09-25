# CODEBASE FORENSIC DATA-FLOW REPORT

## 1. Files Inspected
- **Android**: `TradeAlertManager.kt`
- **Android**: `TradeAlertScreen.kt`
- **Android**: `ExchangeViewModel.kt`
- **Android**: `BotRepositoryImpl.kt` & `BotRemoteDataSource.kt`
- **Android**: `ExecuteTradeRequestDto.kt`
- **Backend**: `index.ts`
- **Backend**: `handlers/exchange.ts`
- **Backend**: `trading-bot.ts` (Trading Bot Durable Object)
- **Backend**: `exchanges/ExchangeManager.ts`
- **Backend**: `infrastructure/exchange/adapters/BybitAdapter.ts`

## 2. Trade Detected Source
The Android UI (`TradeAlertScreen.kt`) receives the `TradeAlert` model via `TradeAlertManager.kt`. The exact `entryPrice`, `stopLoss`, and `takeProfit` are read directly from the `TradeAlert` intent extras and shown on screen.

## 3. Execute Trade Source
When the user taps "Execute Trade", `ExchangeViewModel.kt` creates a complete `ExecuteTradeRequestDto` with `targetEntryPrice`, `stopLoss`, and `takeProfit` populated (Lines 718-800). 
However, **this DTO is instantly discarded**. The ViewModel calls `botRepository.executeTrade(alertId)` instead. The networking layer (`BotRemoteDataSource.kt`) constructs a **new, empty DTO** containing only `{ "alertId": "..." }` and POSTs it to the backend. None of the user's visible numbers leave the Android device.

## 4. Backend Execution Path
1. The backend API (`index.ts`) routes `/trading-bot/execute-trade` to `handleExecuteTrade` (`exchange.ts`).
2. `handleExecuteTrade` simply proxies the `{ alertId }` payload to the `TradingBot` Durable Object (`trading-bot.ts`).
3. Inside the Durable Object (`trading-bot.ts:1028`), the bot looks up the `alertId` in its own in-memory state (`this.runtimeState.alerts`). It fetches the `stopLoss` and `takeProfit` from its own memory snapshot.
4. The DO constructs an `executionSnapshot` and an `OrderRequest`, passing the DO's memory values for SL and TP.
5. The `OrderRequest` is passed to `ExchangeManager.executeIdempotentOrder` -> `BybitAdapter.createOrder`.
6. In `BybitAdapter.ts` (Lines 816-834), the prices are passed to `formatPrice(tpBN, roundMode)` which dynamically rounds and quantizes the values to match Bybit's tick size limits before sending the HTTP POST to Bybit.

## 5. Value Tracking Table

| Stage | Entry Price | Stop Loss (SL) | Take Profit (TP) |
| :--- | :--- | :--- | :--- |
| **1. UI Display** | Exact Value (e.g. 10) | Exact Value (e.g. 9) | Exact Value (e.g. 12) |
| **2. Android Request Payload** | `null` (Dropped) | `null` (Dropped) | `null` (Dropped) |
| **3. Backend Received Payload** | `null` | `null` | `null` |
| **4. Backend Internal State** | Exact Value | Exact Value | Exact Value |
| **5. Bybit Adapter (Pre-Send)** | Quantized (`ROUND_HALF_UP`) | Quantized (`ROUND_FLOOR` or `ROUND_CEIL`) | Quantized (`ROUND_CEIL` or `ROUND_FLOOR`) |
| **6. Trade Confirmation** | Avg Fill from Bybit | Exact Value (from DO State) | Exact Value (from DO State) |

## 6. Value Mutations
1. **Client Discard**: The Android app creates a full DTO but intentionally drops it, replacing it with an empty DTO containing only `alertId`.
2. **Adapter Quantization**: `BybitAdapter.ts` strictly mutates the exact SL/TP prices. It uses `BigNumber.ROUND_CEIL` or `BigNumber.ROUND_FLOOR` based on trade direction (Buy/Sell) to ensure the numbers exactly match Bybit's tick size precision (e.g., modifying 12.0000000001 to 12.00).

## 7. Critical Findings
1. **Total Client-Server Disconnect**: The frontend prices are entirely decorative at the moment of execution. The server ignores the client entirely (except for the `alertId`) and trusts its own memory.
2. **Unquantized State Persistence**: While `BybitAdapter` sends quantized, safe numbers to Bybit, the backend persists the **unquantized, exact numbers** into the `trade_positions` SQL database (line 1451).
3. **Implicit Trust**: If the DO's internal `alerts` array is cleared (e.g., DO eviction or restart without persistence), executing a trade will fail completely because the backend has no fallback for the parameters.

## 8. Final Status
**DISCOVERY COMPLETE**. The exact data-flow has been forensically tracked from the Android UI presentation down to the Bybit HTTP request. The values displayed to the user are derived from the same root alert as the backend's memory, but the client payload itself is discarded, and the adapter performs mandatory price mutation before execution.
