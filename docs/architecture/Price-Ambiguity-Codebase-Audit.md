# Price Ambiguity Read-Only Codebase Audit & Architectural Review

> **Document Type:** Architectural Audit & Codebase Evidence Report  
> **Target Version:** Version 1.0.0 Post-Freeze Audit (Prerequisite for v1.1 Refinement)  
> **Mode:** Read-Only Audit & Evidence Gathering — Zero Code Modifications Performed  

---

## Executive Summary

A comprehensive read-only audit of the Version 1.0.0 codebase was conducted to evaluate price-related data definitions, storage locations, mutability, and lifecycle management.

This audit confirms that **Entry Price Ambiguity is present in the active codebase implementation**, not just in documentation. Currently, a single overloaded field name (`entryPrice` / `entry_price`) represents three distinct values at different lifecycle stages. Furthermore, the user's planned `targetEntryPrice` is lost upon bot activation due to missing API and storage parameters.

---

## 1. Audit Responses to Specific Questions

### Question 1: Is this issue present in the actual implementation, or only in our documentation?
**Finding:** It is present in the **actual codebase implementation**.

#### Code Evidence:
- **`TradingSignal.ts` (line 16):** Defines `entryPrice: number | null`.
- **`SignalEngine.ts` (line 73):** Sets `entryPrice: context.currentPrice` (live market price when signal fires).
- **`trading-bot.ts` (line 44):** Defines `interface TradeAlert` with `entryPrice: number`.
- **`trading-bot.ts` (line 927):** Populates `entryPrice: price` where `price` is fetched from live ticker (`adapter.fetchTicker(coinId)`).
- **`trading-bot.ts` (line 689):** Overwrites `entryPrice` with `orderResult.price` (actual exchange fill price) when saving to `trade_positions`.

---

### Question 2: Where exactly is `entryPrice` defined, stored, modified, and consumed?

#### A. Definitions
1. **`backend/src/engine/signal/TradingSignal.ts` (line 16):**
   ```typescript
   export interface TradingSignal {
     ...
     entryPrice: number | null;
     ...
   }
   ```
2. **`backend/src/trading-bot.ts` (line 44):**
   ```typescript
   interface TradeAlert {
     ...
     entryPrice: number;
     ...
   }
   ```
3. **`backend/migrations/0015_create_trade_positions.sql` (line 6):**
   ```sql
   entry_price REAL NOT NULL,
   ```

#### B. Storage Locations
1. **Durable Object Storage KV:** Stored inside the `alerts` JSON array (`TradeAlert.entryPrice`).
2. **Durable Object WAL Storage:** Stored in `pendingPositionSync` KV object before D1 insertion (`positionData.entryPrice`).
3. **D1 SQLite Database:** Stored in `trade_positions` table under `entry_price` column.

#### C. Modifications & Overwrites
1. **`TradingBot.alarm()` (`trading-bot.ts`, line 927):** Overwritten with `ticker?.price || 0` (live market price at signal generation).
2. **`TradingBot.fetch('/execute-trade')` (`trading-bot.ts`, line 689):** Overwritten with `orderResult.price > 0 ? orderResult.price : target.entryPrice` (fill price).

#### D. Consumption
1. **Quantity Calculation (`trading-bot.ts`, line 651):**
   ```typescript
   const rawQty = target.positionSize > 0 && target.entryPrice > 0
     ? target.positionSize / target.entryPrice
     : undefined;
   ```
2. **Audit Logging (`trading-bot.ts`, line 645):** Logged as `entryPrice: target.entryPrice`.
3. **Realized PnL Calculation (`trading-bot.ts`, line 1042):**
   ```typescript
   const realizedPnl = (priceDiff / position.entry_price) * position.quantity * position.entry_price;
   ```

---

### Question 3: Which DTOs, entities, database tables, APIs, ViewModels, and services currently use it?

* **Engine Interfaces:** `TradingSignal`, `SignalContext` (`currentPrice`).
* **Storage Interfaces:** `TradeAlert`, `AnalysisSnapshot`, `NearMatch` (`estimatedEntry`).
* **Database Tables:** `trade_positions` (`entry_price` column).
* **API Payloads & Endpoints:**
  * `POST /bot/activate` payload (`{ userId, coinId, strategy, positionSize }`) — **lacks targetEntryPrice**.
  * `POST /execute-trade` payload (`{ alertId }`).
  * `GET /alerts` response (`TradeAlert[]`).
* **Services & DO Handlers:** `SignalEngine`, `TradingBot` DO, `ReconciliationEngine`, `EngineAPIService`.

---

### Question 4: Does the current implementation overwrite the user's original entry price when a signal is generated?
**Finding:** **Yes, completely.**

#### Code Evidence:
In `backend/src/handlers/exchange.ts` (line 465), `handleActivateTradingBot` accepts:
```typescript
const { coinId, strategy, positionSize } = await c.req.json<{ coinId: string; strategy: string; positionSize?: number }>();
```
The user's planned entry price from Trade Setup is **never sent to the backend** or stored in DO storage. 

Later, when `TradingBot.alarm()` runs (line 927):
```typescript
const alert: TradeAlert = {
  ...
  entryPrice: price, // Fetched live from adapter.fetchTicker(coinId)
  ...
};
```
The system populates `entryPrice` with the live market price at the moment of signal generation, completely losing the user's original target price.

---

### Question 5: Is there any risk of losing the user's planned entry price during the lifecycle?
**Finding:** **100% Risk — Currently Lost by Design.**

Because neither `POST /bot/activate` nor `TradingBot` DO storage maintains a `targetEntryPrice` property, the user's planned entry price exists only in transient Android ViewModel memory during trade setup and disappears once the user navigates away or activates the bot.

---

### Question 6: Are SL/TP calculations always based on the correct price, or can they become inconsistent?
**Finding:** **Inconsistencies Exist Between Setup Preview and Signal Execution.**

#### Code Evidence:
1. **SignalEngine Execution (`SignalEngine.ts`, lines 59-65):**
   ```typescript
   const stopLoss = proposedType === SignalType.BUY 
     ? context.currentPrice - riskAssessment.stopLossDistance
     : context.currentPrice + riskAssessment.stopLossDistance;
   ```
   SL/TP are calculated relative to `context.currentPrice` at signal generation time.
2. **Fallback Slicing (`trading-bot.ts`, lines 928-929):**
   ```typescript
   stopLoss: sig.stopLoss || price * 0.99,
   takeProfit: sig.takeProfit || price * 1.01,
   ```
3. **Inconsistency Risk:**
   * If a user sets a target entry price of **50,000 USDT** and ATR stop loss distance is **1,000 USDT**, the user expects SL at **49,000 USDT**.
   * If market price moves to **51,000 USDT** before the signal triggers, `SignalEngine` calculates `SL = 51,000 - 1,000 = 50,000 USDT`.
   * The actual stop loss boundary shifts by 1,000 USDT without user awareness because SL/TP calculations evaluate relative to `currentPrice` at signal time rather than `targetEntryPrice`.

---

### Question 7: Are there any other price-related ambiguities identified?

We identified **four additional price-related ambiguities** in the codebase:

#### 1. Zero Fill Price Fallback Corruption (`trading-bot.ts`, line 689)
```typescript
entryPrice: orderResult.price > 0 ? orderResult.price : target.entryPrice
```
If an exchange adapter returns `price: 0` or `undefined` for a market order fill, the system falls back to `target.entryPrice` (the signal price), recording an inaccurate fill price in `trade_positions`.

#### 2. Position Size Currency Unit Ambiguity (`trading-bot.ts`, lines 651 & 690)
* `TradeAlert.positionSize` is quote currency (USDT, e.g. `$1,000`).
* `trade_positions.quantity` is base asset quantity (BTC, e.g. `0.020`).
* The field name `positionSize` is used ambiguously in both API payloads and internal logs without specifying units (`positionSizeUsdt` vs `quantityBase`).

#### 3. Hardcoded Zero Estimated PnL (`trading-bot.ts`, line 930)
```typescript
estimatedPnl: 0,
```
`TradeAlert` hardcodes `estimatedPnl: 0` instead of computing `(takeProfit - entryPrice) * (positionSize / entryPrice)`.

#### 4. Monitoring Price vs. Close Price Discrepancy (`trading-bot.ts`, lines 1007-1044)
`monitorOpenPositions()` fetches `ticker.price` to check SL/TP breaches. If breached, it closes the position in D1 using `currentPrice` as `close_price` rather than querying the actual order fill response from the exchange.

---

## 2. Professional Algorithmic Trading Platform Comparison

| Platform | Target Entry Representation | Signal Price Representation | Fill Price Representation |
| :--- | :--- | :--- | :--- |
| **QuantConnect** | `LimitPrice` / `OrderTicket.Target` | `Bar.Close` / `Tick.Last` | `OrderEvent.FillPrice` |
| **3Commas** | `OrderTargetPrice` | `SignalPrice` | `AverageFillPrice` |
| **TradingView (Pine)** | `strategy.entry(limit=...)` | `strategy.position_avg_price` | `trade.entry_price()` |
| **MetaTrader 5 (MQL5)**| `ENUM_ORDER_PROPERTY_PRICE_OPEN` | `SymbolInfoDouble(SYMBOL_BID)` | `DEAL_PRICE` |
| **CryptoPulse (Current)**| Overloaded `entryPrice` (Lost) | Overloaded `entryPrice` | Overloaded `entry_price` |

### Architectural Industry Standard:
Professional platforms enforce **strict immutability and separation** between the planned target entry price, the strategy signal trigger price, and the final exchange fill price.

---

## 3. Recommendations & Action Plan

We strongly recommend **introducing explicit, disambiguated fields** (`targetEntryPrice`, `signalPrice`, `fillPrice`) in the `v1.1` release cycle.

### Recommended Renaming Matrix:

```
+-----------------------------------------------------------------------------------+
|                           PROPOSED FIELD DISAMBIGUATION                           |
+-----------------------------------------------------------------------------------+
| 1. targetEntryPrice : User-specified target price from Trade Setup (Optional).    |
| 2. signalPrice      : Market price when strategy triggered signal (Required).     |
| 3. fillPrice        : Actual fill price returned by exchange order (Required).    |
+-----------------------------------------------------------------------------------+
```

### Categorized Recommendations (Prioritized by Severity):

#### Priority 1 (High Severity — Slippage & Data Integrity):
* Introduce `targetEntryPrice?: number` in `BotActivationPayload` and store in DO KV storage.
* Rename `TradingSignal.entryPrice` to `TradingSignal.signalPrice`.
* Update `TradeAlert` DTO to include both `signalPrice: number` and `targetEntryPrice?: number`.

#### Priority 2 (Medium Severity — Database Schema & Fallback Bugs):
* Add D1 migration adding `target_entry_price REAL` and `fill_price REAL` to `trade_positions`.
* Fix zero fill price fallback in `trading-bot.ts` (query ticker if order fill price is 0).

#### Priority 3 (Low Severity — Presentation & Unit Clarification):
* Rename `positionSize` in setup DTOs to `positionSizeUsdt`.
* Populate `TradeAlert.estimatedPnl` using `(takeProfit - signalPrice) * quantity`.

---

## Conclusion & Next Steps

This read-only audit proves that **Entry Price Ambiguity is an active code defect in Version 1.0.0**, causing user target entry prices to be lost upon activation. 

No code changes have been executed. We await your review of these findings before incorporating the disambiguation model into the `v1.1` implementation roadmap.
