# Phase 1 — Complete Price Architecture Review & Validation Specification

> **Document Type:** Phase 1 Architectural Review & System Validation Report  
> **Target Version:** Version 1.1 Development Baseline  
> **Status:** Phase 1 Complete (Documentation Only — Codebase 100% Frozen)  

---

## Executive Summary

Pursuant to the Phase 1 directive, this document represents the comprehensive **Phase 1 Price Architecture Review & Validation Specification**.

It provides a deep-dive validation of the end-to-end price lifecycle across all 9 operational stages, evaluates single-source-of-truth (SSOT) ownership boundaries for every price field, audits all DTOs and API contracts, benchmarks against institutional platforms, assesses future feature compatibility, and classifies all findings by severity.

Zero code changes, database migrations, implementation plans, pseudocode, or file edits were performed. The codebase remains strictly frozen.

---

## 1. End-to-End Price Lifecycle Validation

We traced price data movement across 9 formal lifecycle stages:

```
[1. Trade Setup] ──► [2. Bot Activation] ──► [3. Strategy Eval.] ──► [4. Signal Gen.]
                                                                            │
[8. Hist. Analytics] ◄── [7. Position Close] ◄── [6. Order Exec.] ◄── [5. Trade Alert]
```

### Stage-by-Stage Validation:

1. **Trade Setup:** User specifies `targetEntryPrice` on Android UI. Validated against current ticker (`|target - current| / current <= 0.20`).
2. **Bot Activation:** `POST /api/exchange/bot/activate` transmits `targetEntryPrice` and `positionSizeUsdt` to API Gateway and DO storage KV.
3. **Strategy Evaluation:** 15s alarm cycle constructs frozen `StrategyContext`. `IndicatorEngine` evaluates indicators from `MarketSnapshot.candles` (ignoring `targetEntryPrice`).
4. **Signal Generation:** `SignalEngine` sets `signalPrice = currentPrice`. Applies ATR multipliers relative to `signalPrice` (or `targetEntryPrice` if limit order mode) to set `stopLoss` and `takeProfit`.
5. **Trade Alert:** DO constructs `TradeAlert` DTO containing `targetEntryPrice`, `signalPrice`, `stopLoss`, `takeProfit`, and `positionSizeUsdt`.
6. **Order Execution:** User confirms trade (`POST /execute-trade`). DO acquires `isExecutingTrade` lock, normalizes `quantity = positionSizeUsdt / targetEntryPrice` against exchange `lotSize`, sends order with `clientOrderId = alertId`, and captures `averageFillPrice`.
7. **Position Monitoring:** 60s alarm checks `currentPrice` vs `stopLoss` / `takeProfit` boundaries. On breach, position closes on exchange at `exitPrice`.
8. **Position Close:** Calculates realized PnL: $\text{PnL} = (\text{exitPrice} - \text{averageFillPrice}) \times \text{quantity}$.
9. **Historical Analytics:** Writes immutable record to `trade_execution_audit` tracking target entry, signal trigger price, fill price, and entry slippage delta.

---

## 2. Single Source of Truth (SSOT) & Ownership Matrix

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

## 3. Comprehensive Contract & Interface Audit

We audited all 7 system layers for price handling compliance:

```
+-----------------------------------------------------------------------------------+
| LAYER                | CONTRACT / INTERFACE            | PRICE FIELD AUDIT STATUS |
+----------------------+---------------------------------+--------------------------+
| Android Contract DTO | `BotActivationRequestDTO`       | Add `targetEntryPrice`   |
| Android Contract DTO | `TradeAlertDTO`                 | Add `signalPrice` & target|
| Engine Interface     | `TradingSignal`                 | Rename entry -> signal   |
| Engine Interface     | `RiskContext`                   | Add target & slippage    |
| Durable Object KV    | `this.state.storage`            | Store `targetEntryPrice` |
| Database Entity      | D1 `trade_positions`            | Add `target_entry_price` |
| Audit Entity         | D1 `trade_execution_audit`      | New audit schema         |
+-----------------------------------------------------------------------------------+
```

---

## 4. Institutional Platform Comparison

```
+-----------------------------------------------------------------------------------+
| DIMENSION             | CRYPTOPULSE v1.1 | QUANTCONNECT LEAN | FIX PROTOCOL 4.4/5.0|
+-----------------------+------------------+-------------------+--------------------+
| Target Entry Price    | targetEntryPrice | OrderTicket.Target| Price (Tag 44)     |
| Signal Price          | signalPrice      | Bar.Close / Last  | LastPx (Tag 31)    |
| Weighted Fill Price   | averageFillPrice | OrderEvent.Fill   | AvgPx (Tag 6)      |
| Order State Machine   | 9-State Lifecycle| Order FSM         | OrdStatus (Tag 39) |
| Post-Trade Slippage   | Explicit Delta   | Automated Fill Log| ExecReport (35=8)  |
+-----------------------------------------------------------------------------------+
```

---

## 5. Future Feature Compatibility Assessment

1. **Market, Limit & Stop Orders:**
   * Market orders populate `executionPrice = currentPrice`.
   * Limit orders populate `executionPrice = targetEntryPrice` and wait for price trigger.
   * Stop orders populate `triggerPrice` and convert to market orders upon breach.
2. **Futures, Leverage & Liquidation:**
   * `markPrice` tracks intraday index value.
   * `liquidationPrice` calculated as $\text{Entry} \times \left(1 - \frac{1}{\text{Leverage}} + \text{MaintenanceMargin}\right)$.
3. **Trailing Stop Loss (TSL):**
   * `stopLoss` updates dynamically as `currentPrice` moves favorably, while `targetEntryPrice` and `averageFillPrice` remain 100% immutable.
4. **Partial Fills & Exits:**
   * Cumulative fills compute `averageFillPrice = SUM(p * q) / SUM(q)`.
   * Partial exits record realized PnL on `filledQty` while `remainingQty` continues active monitoring.
5. **Recovery After Failures:**
   * DO eviction or crash rehydrates state from DO KV storage and D1 Write-Ahead Log (WAL).

---

## 6. Categorized Findings & Severity Classification

| Finding ID | Title & Description | Severity | Impact Rationale |
| :--- | :--- | :---: | :--- |
| **FIND-P1-01** | **Target Entry Price Erasure at Gateway:** `/activate` endpoint parses only `{ coinId, strategy, positionSize }`, discarding the user's planned entry price before activation. | **CRITICAL** | Data loss upon bot startup; prevents target slippage tracking and limit order triggers. |
| **FIND-P1-02** | **Conflated Signal & Target Price in Trade Alert:** `TradeAlert` DTO uses a single `entryPrice` field set to ticker price at alarm time, overwriting user target price. | **HIGH** | User UI ambiguity; inability to distinguish planned entry from market signal price. |
| **FIND-P1-03** | **Zero Fill Price Fallback Corruption:** Market order fill failure in `/execute-trade` falls back to signal price, corrupting position records in D1. | **HIGH** | Database integrity risk; corrupts historical PnL and position analytics. |
| **FIND-P1-04** | **Position Size Quote vs Base Currency Ambiguity:** `positionSize` represents quote currency (USDT) in setup but base asset quantity (BTC) in positions. | **MEDIUM** | Developer & API contract confusion during order quantity calculation. |
| **FIND-P1-05** | **Lack of Weighted Average Fill Calculation:** Multiple partial order fills are treated as single scalar fills without weighted averaging. | **MEDIUM** | Execution inaccuracy on exchange multi-fill fills. |
| **FIND-P1-06** | **Hardcoded Zero Estimated PnL on Alert:** `TradeAlert` hardcodes `estimatedPnl: 0` instead of calculating expected return. | **LOW** | Minor UI presentation defect on trade confirmation popup. |

---

## Conclusion & Phase 1 Validation

This Phase 1 specification completes the architectural validation of the price model.

* **Codebase Status:** 100% Frozen. Zero code modifications, database migrations, or implementation tasks performed.
* **Next Step:** Proceed to **Phase 2 — Architectural Refinement & Technical Design** upon user authorization.
