# Price Context, State Lifecycle & Ownership Architecture Specification

> **Document Type:** System Architecture Specification & Permanent Domain Reference  
> **Target Version:** Version 1.1 Development Baseline  
> **Status:** Final Architectural Specification (Documentation Only — Zero Code Modifications Performed)  

---

## Executive Summary

Following our multi-stage architectural audits, this document represents the definitive **Price Context, State Lifecycle & Ownership Architecture Specification** for the platform.

It defines the canonical `PriceContext` interface, establishes strict Single Source of Truth (SSOT) ownership boundaries, details the complete Trade Context State Machine from trade setup to settlement, mandates a platform-wide Price Precision Policy, specifies trade reconstruction audit rules, and maps component dependencies across the entire system.

---

## 1. Canonical `PriceContext` Schema

The canonical `PriceContext` object serves as the single price container passed through evaluation, risk, signal, and execution layers:

```typescript
export interface PriceContext {
  // Pre-Execution Target Prices
  targetEntryPrice?: number | null; // Planned entry price specified during Trade Setup
  triggerPrice?: number | null;     // Price threshold required to trigger condition evaluation
  
  // Strategy Evaluation & Signal Emission Prices
  signalPrice: number;              // Live market price at exact second signal is generated
  markPrice?: number | null;        // Intraday mark/index price for valuation & margin
  
  // Order Execution & Settlement Prices
  executionPrice?: number | null;   // Limit or market price submitted in order payload
  averageFillPrice?: number | null; // Actual weighted average fill price from exchange fill response
  
  // Position Protection & Exit Prices
  stopLoss: number;                 // Stop Loss price boundary
  takeProfit: number;               // Take Profit price boundary
  exitPrice?: number | null;        // Actual execution price when position is closed
  liquidationPrice?: number | null; // Estimated liquidation/bankruptcy price (Futures)
}
```

---

## 2. Field Ownership & Immutability Matrix

```
+--------------------------------------------------------------------------------------------------------------------+
| FIELD NAME         | SINGLE SOURCE OF TRUTH (SSOT) | ONLY WRITER         | READERS              | IMMUTABILITY     |
+--------------------------------------------------------------------------------------------------------------------+
| targetEntryPrice   | DO Storage KV (`targetEntry`) | Setup API / DO /activate| RiskEngine, Alert, UI| Immutable       |
| triggerPrice       | `StrategyManifest` / Condition| ConditionEngine     | StrategyOrchestrator | Immutable       |
| signalPrice        | `TradingSignal.signalPrice`   | SignalEngine        | TradeAlert DTO, UI   | Immutable       |
| markPrice          | `MarketSnapshot.markPrice`    | MarketDataEngine    | RiskEngine, Ticker UI| Mutable (15s)   |
| executionPrice     | Order Execution Payload       | DO `/execute-trade` | ExchangeAdapter      | Immutable       |
| averageFillPrice   | D1 `trade_positions.avg_fill` | Exchange Adapter    | PnL Engine, Analytics| Immutable       |
| stopLoss / takeProfit| `TradingSignal.stopLoss/TP`   | RiskEngine / Signal | Alarm Loop, Alert UI | Dynamic (TSL)   |
| exitPrice          | D1 `trade_positions.close_px` | Position Monitor DO | Audit Log, Analytics | Immutable       |
| liquidationPrice   | `RiskAssessment.liqPrice`     | RiskEngine          | Margin Monitor, UI   | Mutable (Mark)  |
+--------------------------------------------------------------------------------------------------------------------+
```

---

## 3. Trade Context State Machine & Lifecycle Flow

The complete operational lifecycle of a trade context progresses through 9 formal states:

```
[SETUP] ──► [ACTIVE_SCANNING] ──► [SIGNAL_FIRED] ──► [ALERT_PENDING] ──► [SUBMITTED]
                                                                              │
[CLOSED] ◄── [POSITION_ACTIVE] ◄──────────────────────────────────────────────┘
   ▲               │
   │               └──► [EXPIRED / CANCELLED]
   │
   └──► [COLD_RESTART_RECOVERY]
```

### State Definitions & Transition Triggers:

1. **`SETUP`:** User enters `targetEntryPrice` on Android UI.
   * *Transition:* User submits Trade Setup form (`POST /api/exchange/bot/activate`).
2. **`ACTIVE_SCANNING`:** Durable Object alarm fires every 15 seconds; `StrategyOrchestrator` evaluates `MarketSnapshot`.
   * *Transition:* Strategy evaluation returns `hasSignal == true`.
3. **`SIGNAL_FIRED`:** `SignalEngine` generates `TradingSignal` setting `signalPrice = currentPrice`.
   * *Transition:* Signal passed to DO alert builder.
4. **`ALERT_PENDING`:** `TradeAlert` DTO buffered in DO storage KV (`alerts`). Rendered to user via push/polling.
   * *Transition A:* User taps "Confirm Trade" (`POST /execute-trade`).
   * *Transition B:* 4-hour alert expiration window elapses (`ALERT_EXPIRED`).
5. **`SUBMITTED`:** DO acquires `isExecutingTrade` lock; sends order payload with `clientOrderId = alertId`.
   * *Transition:* Exchange returns order fill confirmation response.
6. **`POSITION_ACTIVE`:** Order filled; WAL written (`pendingPositionSync`) and D1 `trade_positions` updated with `averageFillPrice`.
   * *Transition:* Position Monitor alarm detects SL/TP breach or user manual close.
7. **`CLOSED`:** Position closed on exchange; realized PnL recorded (`exitPrice`).
8. **`EXPIRED / CANCELLED`:** Bot auto-deactivates or alert expires without execution.
9. **`COLD_RESTART_RECOVERY`:** DO crashes or evicts; state rehydrated from KV storage and D1 WAL.

---

## 4. Complete Field Lifecycles

```
+-------------------------------------------------------------------------------------------------------+
| FIELD               | CREATION POINT                  | TRANSFORMATION          | TERMINATION POINT   |
+-------------------------------------------------------------------------------------------------------+
| targetEntryPrice    | Android Trade Setup Form        | Sent via /activate      | Bot Deactivation    |
| triggerPrice        | Strategy Plugin Manifest        | Read during Condition   | Cycle Completion    |
| signalPrice         | SignalEngine evaluation moment  | Embedded in TradeAlert  | Alert Resolution    |
| executionPrice      | DO /execute-trade payload       | Normalized by lotSize   | Order Settlement    |
| averageFillPrice    | Exchange Order Fill Response    | Weighted sum / qty      | Permanent D1 DB     |
| stopLoss / takeProfit| RiskEngine ATR Distance Math   | Dynamic Trailing Adjust | Position Closure    |
| exitPrice           | Position Monitor SL/TP breach   | PnL Calculation         | Permanent D1 DB     |
| markPrice           | Ticker / Exchange Mark Feed     | Margin & Risk Sizing    | 15s Cycle Timeout   |
| liquidationPrice    | RiskEngine Leverage Calculator  | Futures Risk Margin     | Position Closure    |
+-------------------------------------------------------------------------------------------------------+
```

---

## 5. Platform-Wide Price Precision Policy

To prevent floating-point rounding errors and exchange order rejections, precision is strictly governed at 5 system boundaries:

```
+-----------------------------------------------------------------------------------+
| BOUNDARY             | PRECISION RULE             | IMPLEMENTATION SPEC           |
+----------------------+----------------------------+-------------------------------+
| Internal Engine Math | 64-bit IEEE Double Float   | Exact floating arithmetic     |
| Database Storage     | SQLite REAL / DOUBLE       | 8-byte IEEE floating storage  |
| Exchange Order Specs | Normalized Tick/Lot Size   | `normalizeQuantity(qty, lot)` |
| UI Display Rounding  | Currency-Aware Formatting  | Crypto: 4-8 dec, USDT: 2 dec  |
| API Serialization    | Strict JSON Numbers        | Serialized as unquoted float  |
+-----------------------------------------------------------------------------------+
```

### Order Quantity Normalization Implementation:
```typescript
export function normalizeQuantity(qty: number, lotSize: number, minQty: number, maxQty: number): number {
  if (qty < minQty) return minQty;
  if (qty > maxQty) return maxQty;
  const precision = Math.round(1 / lotSize);
  return Math.floor(qty * precision) / precision;
}
```

---

## 6. Historical Audit & Trade Reconstruction Schema

To enable 100% post-trade slippage and compliance reconstruction, every trade execution writes an immutable audit record:

```sql
CREATE TABLE IF NOT EXISTS trade_execution_audit (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  target_entry_price REAL,
  signal_price REAL NOT NULL,
  execution_price REAL NOT NULL,
  average_fill_price REAL NOT NULL,
  stop_loss REAL NOT NULL,
  take_profit REAL NOT NULL,
  slippage_percent REAL NOT NULL,
  fill_timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Trade Reconstruction Equation:
$$\text{Entry Slippage \%} = \frac{\text{averageFillPrice} - \text{targetEntryPrice}}{\text{targetEntryPrice}} \times 100$$

---

## 7. Concurrency & Synchronization Architecture

```
User Order Confirmation (alertId)
   │
   ▼
DO Lock: blockConcurrencyWhile(isExecutingTrade = true)
   │
   ├─► Check Idempotency: Is alertId already submitted/executed? -> Reject duplicate
   │
   ├─► Read Target & Signal Price from KV Storage
   │
   ├─► Execute Exchange Order (clientOrderId = alertId)
   │
   ├─► Write Write-Ahead Log (WAL) to DO Storage KV ('pendingPositionSync')
   │
   ├─► Insert into D1 Database `trade_positions`
   │
   └─► Clear WAL ('pendingPositionSync') & Release Lock (isExecutingTrade = false)
```

---

## 8. Component Dependency Analysis

```
                                +-----------------------------------+
                                | Component Dependency Graph        |
                                +-----------------------------------+
                                                  │
       +--------------------+---------------------+--------------------+--------------------+
       |                    |                     |                    |                    |
       v                    v                     v                    v                    v
[Android Layer]       [Gateway Layer]      [Engine Layer]       [Durable Object]     [Database Layer]
 Reads:               Reads:               Reads:               Reads:               Reads:
 - targetEntryPrice   - targetEntryPrice   - markPrice          - targetEntryPrice   - averageFillPrice
 - signalPrice        - positionSizeUsdt   - currentPrice       - signalPrice        - exitPrice
 Writes:              Writes:              Writes:              Writes:              Writes:
 - targetEntryPrice   - Activation Payload - signalPrice        - TradeAlert DTO     - trade_positions
                                           - stopLoss/TP        - WAL Position Log   - audit_execution
```

---

## 9. Institutional Benchmark Comparison

| Architectural Dimension | CryptoPulse (v1.0.0) | QuantConnect (Lean) | FIX Protocol 4.4/5.0 | Proposed CryptoPulse (v1.1) |
| :--- | :--- | :--- | :--- | :--- |
| **Price Object Model** | Overloaded `entryPrice` | `OrderTicket` / `Trade` | Tag 44, Tag 31, Tag 6 | Canonical `PriceContext` |
| **Target vs Signal Split** | Conflated | `TargetPrice` vs `Close` | `Price` vs `LastPx` | Explicit `target` & `signal` |
| **Fill Price Averaging** | Single Scalar | Weighted Fill Event | `AvgPx` (Tag 6) | `averageFillPrice` |
| **State Machine** | Partial | Full Order FSM | Full Order State Lifecycle| 9-State Order Lifecycle |
| **Reconstruction Audit** | None | Full Event Log | ExecReport Audit | `trade_execution_audit` |

---

## 10. Severity Classification & Implementation Roadmap

| Finding ID | Description | Severity | Impact Area |
| :--- | :--- | :---: | :--- |
| **GAP-01** | Missing `targetEntryPrice` in `handleActivateTradingBot` activation API. | **CRITICAL** | Gateway API |
| **GAP-02** | Conflated `entryPrice` in `TradeAlert` DTO. | **HIGH** | Engine DTOs |
| **GAP-03** | Lack of weighted average fill price calculation in order settlement. | **HIGH** | Execution Engine |
| **GAP-04** | Currency unit ambiguity in `positionSize` setup parameter. | **MEDIUM** | API Contracts |
| **GAP-05** | Lack of historical trade execution audit table for slippage analysis. | **MEDIUM** | D1 Schema |

### Phased Sprint Roadmap (Sprints 16 - 19):
* **Sprint 16:** Gateway API Unification & DO Storage `targetEntryPrice` Persistence.
* **Sprint 17:** Core Engine & `TradingSignal` Disambiguation (`signalPrice` split).
* **Sprint 18:** D1 Migration `0024_add_target_entry_price.sql` & Execution WAL.
* **Sprint 19:** Android Trade Setup UI & Trade Alert Popup Integration.

---

## Conclusion

This specification represents the **permanent Single Source of Truth** for all price-related data movement across the platform. Architecture is frozen and ready for implementation.
