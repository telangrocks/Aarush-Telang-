# Price Model & Trade Context Architecture Specification

> **Document Type:** System Architecture Specification & Domain Reference  
> **Target Version:** Version 1.1 Development Cycle (Design Blueprint)  
> **Status:** Final Architectural Specification (Documentation Only)  

---

## Executive Summary

Following our initial code audit, this second read-only architectural specification establishes the comprehensive **Price Model & Trade Context Architecture** for the platform.

It addresses the core structural defects in price handling by establishing a **canonical multi-price domain model**, pinpointing the exact loss points of user-planned entry data, defining the single source of truth for trade context persistence, and mapping downstream component dependencies across the entire system.

---

## 1. Professional Multi-Price Domain Model

To match institutional platforms (QuantConnect, MetaTrader 5, Interactive Brokers, 3Commas), the platform must distinguish between 8 distinct price concepts. Blending these into a single `entryPrice` or `currentPrice` field creates silent slippage bugs and invalid risk calculations.

```
+---------------------------------------------------------------------------------------------------+
| CONCEPT               | DEFINITION                                      | DOMAIN OWNER            |
+---------------------------------------------------------------------------------------------------+
| 1. targetEntryPrice   | User-specified planned entry price (Trade Setup)| Client UI / Setup DTO   |
| 2. triggerPrice       | Price condition threshold for strategy trigger  | ConditionEngine         |
| 3. signalPrice        | Market price when strategy signal generated     | SignalEngine            |
| 4. executionPrice     | Order limit/market price submitted to exchange  | Order Execution Engine  |
| 5. averageFillPrice   | Actual average fill price reported by exchange  | Exchange Fill Response  |
| 6. exitPrice          | Price at which position was closed              | Position Monitoring     |
| 7. markPrice          | Mark/index price used for futures valuation     | Exchange Ticker Stream  |
| 8. liquidationPrice   | Calculated bankruptcy price for leverage        | RiskEngine              |
+---------------------------------------------------------------------------------------------------+
```

### Stable Long-Term Domain Schema (`PriceContext`):

```typescript
export interface PriceContext {
  // Pre-Execution Target Prices
  targetEntryPrice?: number | null; // User's desired entry price from Trade Setup
  triggerPrice?: number | null;     // Strategy condition trigger threshold
  
  // Evaluation & Signal Prices
  signalPrice: number;              // Market price at signal emission (SignalEngine)
  markPrice?: number | null;        // Intraday mark/index price for futures
  
  // Execution & Settlement Prices
  executionPrice?: number | null;   // Price submitted in order request
  averageFillPrice?: number | null; // Actual fill price from exchange fill response
  
  // Exit & Position Protection Prices
  stopLoss: number;                 // Calculated Stop Loss boundary
  takeProfit: number;               // Calculated Take Profit boundary
  exitPrice?: number | null;        // Price at position close
  liquidationPrice?: number | null; // Estimated liquidation price (Futures)
}
```

---

## 2. Trade Context Persistence & Data Loss Point Analysis

### Exact Loss Point Trace in Current Codebase:

```
[Android Trade Setup]
   │  User inputs targetEntryPrice = 50000 USDT
   ▼
[TradeSetupViewModel]
   │  Holds targetEntryPrice in memory
   ▼
[HTTP Request: POST /api/exchange/bot/activate]
   │
   ├─► LOSS POINT 1: exchange.ts line 465
   │   Payload destructuring: const { coinId, strategy, positionSize } = await c.req.json();
   │   --> targetEntryPrice is NOT included in API payload or handler parsing!
   │
   ▼
[TradingBot DO: fetch('/activate')]
   │
   ├─► LOSS POINT 2: trading-bot.ts lines 477-480
   │   await this.state.storage.put('isActive', true);
   │   await this.state.storage.put('coinId', coinId);
   │   await this.state.storage.put('strategy', strategy);
   │   --> targetEntryPrice is NOT saved to Durable Object Storage KV!
   │
   ▼
[TradingBot DO: alarm() Cycle]
   │
   ├─► LOSS POINT 3: trading-bot.ts line 927
   │   const alert: TradeAlert = { entryPrice: price ... };
   │   --> Populates entryPrice with live ticker price, completely ignoring user target!
```

---

## 3. Single Source of Truth & Downstream Price Flow

The **TradingBot Durable Object Storage KV** serves as the single source of truth for active bot configuration and `targetEntryPrice`.

```
                                +-----------------------------+
                                |  DO KV Storage (Truth)      |
                                |  - targetEntryPrice: 50000  |
                                +-----------------------------+
                                               |
                                               v
                                +-----------------------------+
                                |    StrategyOrchestrator     |
                                +-----------------------------+
                                               |
       +---------------------------------------+---------------------------------------+
       |                                       |                                       |
       v                                       v                                       v
+-------------------------------+   +-------------------------------+   +-------------------------------+
| MarketDataEngine              |   | RiskEngine                    |   | SignalEngine                  |
| Reads: Live Candle Closes     |   | Reads: targetEntryPrice & ATR |   | Reads: currentPrice & ATR SL  |
| Ignores: targetEntryPrice     |   | Calculates: SL/TP Distances   |   | Emits: signalPrice & SL/TP    |
+-------------------------------+   +-------------------------------+   +-------------------------------+
                                                                                       |
                                                                                       v
                                                                        +-------------------------------+
                                                                        | TradeAlert DTO                |
                                                                        | Emits: targetEntryPrice &     |
                                                                        |        signalPrice            |
                                                                        +-------------------------------+
                                                                                       |
                                                                                       v
                                                                        +-------------------------------+
                                                                        | Order Execution & D1          |
                                                                        | Records: targetEntryPrice &   |
                                                                        |          averageFillPrice     |
                                                                        +-------------------------------+
```

---

## 4. Comprehensive Dependency & Impact Analysis

| System Layer | Component / File | Impact & Required Changes | Risk Level |
| :--- | :--- | :--- | :---: |
| **Android DTOs** | `BotActivationRequest.kt`, `TradeAlertDto.kt` | Add `targetEntryPrice: Double?` and `signalPrice: Double`. | Low |
| **Android ViewModels** | `TradeSetupViewModel.kt` | Pass `targetEntryPrice` in activation request payload. | Low |
| **Gateway APIs** | `backend/src/handlers/exchange.ts` | Destructure `targetEntryPrice` in `handleActivateTradingBot`. | Low |
| **Durable Object Storage** | `backend/src/trading-bot.ts` | Save `targetEntryPrice` to KV storage (`await storage.put('targetEntryPrice')`). | Low |
| **D1 Database** | `migrations/0024_add_target_entry_price.sql` | Add `target_entry_price REAL` and rename `entry_price` to `average_fill_price`. | Medium |
| **Engine Interfaces** | `TradingSignal.ts`, `SignalEngine.ts` | Set `signalPrice: context.currentPrice` and attach `targetEntryPrice`. | Low |
| **Risk Engine** | `RiskEngine.ts`, `RiskContext.ts` | Incorporate `targetEntryPrice` for slippage checks (`|signalPrice - target|`). | Medium |
| **Trade Alert Generator**| `trading-bot.ts` (`alarm()`) | Populate `TradeAlert` with both `targetEntryPrice` and `signalPrice`. | Low |
| **Order Execution** | `trading-bot.ts` (`/execute-trade`) | Compute quantity using `targetEntryPrice` (or `signalPrice` if market order). | Low |
| **Position Monitoring** | `trading-bot.ts` (`monitorOpenPositions`) | Compare `currentPrice` vs `averageFillPrice` for realized PnL. | Medium |
| **Historical Records** | `audit_log`, `trade_positions` | Store target entry, signal trigger price, and final fill price for post-trade slippage analytics. | Low |

---

## 5. Professional Trading System Comparison

| Architecture Dimension | CryptoPulse (v1.0.0 Current) | QuantConnect (Lean Engine) | MetaTrader 5 (MQL5) | Proposed CryptoPulse (v1.1) |
| :--- | :--- | :--- | :--- | :--- |
| **Target Price Model** | Overloaded `entryPrice` (Lost) | `OrderTicket.TargetPrice` | `ORDER_PRICE_OPEN` | `targetEntryPrice` |
| **Signal Price Model** | Overloaded `entryPrice` | `SymbolData.Close` | `SYMBOL_BID` / `SYMBOL_ASK` | `signalPrice` |
| **Execution Fill Model** | Overloaded `entry_price` | `OrderEvent.FillPrice` | `DEAL_PRICE` | `averageFillPrice` |
| **Slippage Tracking** | Impossible (Data lost) | Automated (`FillPrice - Target`) | Native deal log comparison | Explicit (`signalPrice - targetEntryPrice`) |
| **Engine Decoupling** | Mixed indicator / price logic | Strict separates Bar vs Order | Event-driven OnTick | Strict `StrategyContext` freeze |

---

## 6. Final Architectural Recommendations

1. **Adopt 3-Price Core Schema for v1.1:**
   Adopt `targetEntryPrice`, `signalPrice`, and `averageFillPrice` as the core required price model, with optional slots reserved for `triggerPrice`, `exitPrice`, and `markPrice` for v1.2+ futures expansion.
2. **Implement Loss-Point Fixes in Sprint 16:**
   Update `exchange.ts` and `trading-bot.ts` to capture and store `targetEntryPrice` during bot activation.
3. **Add Non-Destructive D1 Migration:**
   Apply migration `0024_add_target_entry_price.sql` to add `target_entry_price REAL` to `trade_positions` while keeping legacy columns for backward compatibility.
4. **Preserve Engine Freeze:**
   Ensure `IndicatorEngine` and `ConditionEngine` remain 100% frozen, evaluating technical indicators exclusively against `MarketSnapshot.candles`.

---

## Conclusion

This specification provides the definitive **Price Model & Trade Context Architecture** for the platform. No code changes have been performed during this analysis.
