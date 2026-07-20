# Version 1.1 Price Architecture — Final Master Implementation Blueprint

> **Document Type:** Authoritative Final Master System Blueprint  
> **Target Version:** Version 1.1 Development Baseline  
> **Status:** Officially Frozen & Supersedes All Prior Price Documents (Documentation Only — Codebase 100% Frozen)  
> **Authority:** Single Source of Truth for Production Implementation  

---

## Executive Summary

Following a rigorous, multi-stage architectural audit and cross-document validation, this document represents the **Version 1.1 Price Architecture — Final Master Implementation Blueprint**.

It consolidates, unifies, and officially supersedes all previous Price Architecture documents (`Price-Flow-Across-the-Bot-Architecture.md`, `Entry-Price-Disambiguation-Plan.md`, `Price-Ambiguity-Codebase-Audit.md`, `Price-Model-and-Trade-Context-Architecture.md`, `Final-Price-Architecture-Review-and-Implementation-Plan.md`, `Price-Context-State-Lifecycle-and-Ownership-Architecture.md`, `Phase-1-Complete-Price-Architecture-Review.md`, and `Version-1.1-Price-Architecture-Master-Consolidated-Implementation-Plan.md`).

Zero production code modifications, database migrations, pseudocode, or file edits were performed. The codebase remains 100% strictly frozen.

---

## 1. Final Consolidated Terminology

```
+---------------------------------------------------------------------------------------------------+
| FIELD NAME            | DEFINITION & BINDING                            | DOMAIN OWNER            |
+---------------------------------------------------------------------------------------------------+
| targetEntryPrice      | User-specified planned entry price (Trade Setup)| Client UI / Setup DTO   |
| triggerPrice          | Price condition threshold for strategy trigger  | ConditionEngine         |
| signalPrice           | Market price when strategy signal generated     | SignalEngine            |
| executionPrice        | Order limit/market price submitted to exchange  | Order Execution Engine  |
| averageFillPrice      | Actual weighted average fill price from exchange| Exchange Fill Response  |
| stopLoss              | Risk-calculated Stop Loss price boundary        | RiskEngine / Signal     |
| takeProfit            | Risk-calculated Take Profit price boundary      | RiskEngine / Signal     |
| exitPrice             | Actual execution price when position is closed  | Position Monitoring DO  |
| markPrice             | Intraday mark/index price for futures           | MarketDataEngine        |
| liquidationPrice      | Calculated bankruptcy price for leverage        | RiskEngine              |
| positionSizeUsdt      | Position allocation amount in USDT (Quote)      | Trade Setup / DO Storage|
| quantity              | Position asset size in base currency (e.g. BTC) | Execution Sizing        |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. Canonical `PriceContext` Schema

```typescript
export interface PriceContext {
  targetEntryPrice?: number | null; // User's planned entry price from Trade Setup
  triggerPrice?: number | null;     // Price threshold required to trigger condition evaluation
  signalPrice: number;              // Live market price at exact second signal is generated
  markPrice?: number | null;        // Intraday mark/index price for valuation & margin
  executionPrice?: number | null;   // Limit or market price submitted in order payload
  averageFillPrice?: number | null; // Actual weighted average fill price from exchange fill response
  stopLoss: number;                 // Stop Loss price boundary
  takeProfit: number;               // Take Profit price boundary
  exitPrice?: number | null;        // Actual execution price when position is closed
  liquidationPrice?: number | null; // Estimated liquidation/bankruptcy price (Futures)
}
```

---

## 3. Final SSOT Ownership & Immutability Matrix

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

## 4. Final Trade Context Lifecycle & State Machine

```
[SETUP] ──► [ACTIVE_SCANNING] ──► [SIGNAL_FIRED] ──► [ALERT_PENDING] ──► [SUBMITTED]
                                                                              │
[CLOSED] ◄── [POSITION_ACTIVE] ◄──────────────────────────────────────────────┘
   ▲               │
   │               └──► [EXPIRED / CANCELLED]
   │
   └──► [COLD_RESTART_RECOVERY]
```

### Complete Field Lifecycles:
* **`targetEntryPrice`:** Input on Trade Setup Form → Passed via `/activate` → Saved to DO Storage KV → Read by `RiskEngine` → Released on Bot Deactivation.
* **`signalPrice`:** Emitted by `SignalEngine` at 15s evaluation moment → Saved in `TradeAlert` DTO → Persisted in `trade_execution_audit`.
* **`averageFillPrice`:** Captured from Exchange Order Fill Response → Written to DO Write-Ahead Log (`pendingPositionSync`) → Persisted permanently in D1 `trade_positions.avg_fill_price`.

---

## 5. Master Issue Coverage & Verification

All 5 core architectural issues are 100% resolved in this final blueprint:

1. **Entry Price Ambiguity (🔴 Critical):** Explicitly separated into `targetEntryPrice`, `signalPrice`, and `averageFillPrice`.
2. **User Target Entry Price Lost (🔴 Critical):** Captured by `POST /activate` handler and persisted in DO Storage KV.
3. **SL/TP Consistency (🟠 High):** Calculated relative to `targetEntryPrice` in limit mode and guarded by `RiskEngine` entry slippage checks (`|signalPrice - targetEntryPrice| / targetEntryPrice <= maxSlippage`).
4. **Fill Price Fallback Corruption (🟠 High):** Handled via an automated fallback ticker query (`adapter.fetchTicker(symbol)`) if market order returns `price: 0`.
5. **Position Size & Estimated PnL Ambiguity (🟡 Medium):** Renamed setup parameter to `positionSizeUsdt`; dynamically calculated `estimatedPnl = (takeProfit - signalPrice) * quantity`.

---

## 6. Comprehensive Cross-Component Impact Matrix

```
                                +-----------------------------------+
                                | Cross-Component Impact Map        |
                                +-----------------------------------+
                                                  │
       +--------------------+---------------------+--------------------+--------------------+
       |                    |                     |                    |                    |
       v                    v                     v                    v                    v
[Android Layer]       [Gateway Layer]      [Engine Layer]       [Durable Object]     [Database Layer]
 - SetupViewModel      - Activation DTO     - RiskContext        - Storage KV keys    - D1 Migration 0024
 - TradeAlertDto       - Transformation     - SignalContext      - WAL Payload        - Position schema
 - Contract Mapping      Handler              - EngineAPIService   - Alarm state        - Audit log schema
```

---

## 7. Final Implementation Roadmap (Sprints 16 - 19)

```
+-----------------------------------------------------------------------------------+
| SPRINT 16: Gateway Unification & Target Entry Persistence                         |
| 1. Update `handleActivateTradingBot` in `exchange.ts` to parse `targetEntryPrice`.|
| 2. Update `TradingBot.fetch('/activate')` to store `targetEntryPrice` in DO KV.  |
| 3. Unify legacy `handleGetStrategies` in `exchange.ts` with `StrategyRegistry`.   |
| 4. Update API Vitest suite (`tests/api/API.test.ts`).                             |
+-----------------------------------------------------------------------------------+
                                          │
                                          ▼
+-----------------------------------------------------------------------------------+
| SPRINT 17: Engine & DTO Schema Disambiguation                                     |
| 1. Rename `TradingSignal.entryPrice` to `signalPrice` in `TradingSignal.ts`.      |
| 2. Update `SignalEngine.ts` to emit `signalPrice` and attach `targetEntryPrice`.  |
| 3. Update `TradeAlert` DTO interface to include `signalPrice` & `targetEntryPrice`.|
| 4. Implement slippage threshold validation in `RiskEngine.ts`.                     |
+-----------------------------------------------------------------------------------+
                                          │
                                          ▼
+-----------------------------------------------------------------------------------+
| SPRINT 18: Database Migration & Execution Engine Hardening                         |
| 1. Create D1 migration `0024_add_target_entry_price.sql` (`target_entry_price`).  |
| 2. Update `/execute-trade` in `trading-bot.ts` to record `avg_fill_price`.        |
| 3. Add zero fill price fallback ticker query to prevent D1 price corruption.       |
| 4. Create `trade_execution_audit` table in D1 for post-trade slippage analytics.  |
+-----------------------------------------------------------------------------------+
                                          │
                                          ▼
+-----------------------------------------------------------------------------------+
| SPRINT 19: Android UI Integration & End-to-End System Verification                |
| 1. Update `TradeSetupViewModel` on Android to pass `targetEntryPrice`.            |
| 2. Update Trade Alert Popup UI to render Planned Entry vs Market Signal Price.    |
| 3. Populate `TradeAlert.estimatedPnl` dynamically using `(TP - Signal) * Qty`.    |
| 4. Execute full Vitest suite & stress benchmarks to confirm 0 regressions.        |
+-----------------------------------------------------------------------------------+
```

---

## 8. Success Criteria & Verification Metrics

1. **Zero TypeScript Compiler Errors:** `npm run build` exits with code 0.
2. **100% Vitest Pass Rate:** All 59 existing unit, integration, reliability, and stress tests pass.
3. **Price Field Disambiguation Integrity:** Zero instances of overloaded `entryPrice` remain in active DTO contracts.
4. **Target Entry Data Preservation:** 100% of user target entry prices specified in Trade Setup persist into DO KV storage and D1 database audit records.

---

## 9. Architecture Freeze Declaration & Final Validation

### Final Validation Statements:
1. **Superseded Documents:** All prior Price Architecture review documents (`Price-Flow-Across-the-Bot-Architecture.md`, `Entry-Price-Disambiguation-Plan.md`, `Price-Ambiguity-Codebase-Audit.md`, `Price-Model-and-Trade-Context-Architecture.md`, `Final-Price-Architecture-Review-and-Implementation-Plan.md`, `Price-Context-State-Lifecycle-and-Ownership-Architecture.md`, `Phase-1-Complete-Price-Architecture-Review.md`, and `Version-1.1-Price-Architecture-Master-Consolidated-Implementation-Plan.md`) are **OFFICIALLY SUPERSEDED** by this document.
2. **Remaining Architectural Blockers:** There are **ZERO remaining architectural blockers**.
3. **Official Domain Freeze Declaration:**

```
===================================================================================
           OFFICIAL DOMAIN FREEZE DECLARATION — PRICE ARCHITECTURE
===================================================================================
  Domain Name           : Price Architecture & Data Flow
  Release Milestone     : Version 1.1 Baseline
  Domain Freeze Status  : PERMANENTLY FROZEN FOR VERSION 1.1
  Single Source of Truth: Version-1.1-Price-Architecture-Final-Master-Blueprint.md
===================================================================================
```

All future implementation work for the Price Architecture must use this single master blueprint as the sole authoritative reference.
