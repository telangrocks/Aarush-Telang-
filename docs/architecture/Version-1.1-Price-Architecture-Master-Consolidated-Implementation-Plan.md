# Version 1.1 Price Architecture — Master Consolidated Implementation Plan

> **Document Type:** Master Consolidated Architectural Implementation Blueprint  
> **Target Version:** Version 1.1 Development Baseline  
> **Status:** Final Master Specification (Documentation Only — Codebase 100% Frozen)  
> **Authority:** Supersedes all previous Price Architecture review documents  

---

## Executive Summary

Following the completion and freeze of the Price Architecture domain, this document serves as the **Master Consolidated Implementation Plan** for Version 1.1.

It consolidates all findings, audits, specifications, and state machine designs across every previously created Price Architecture document (`Price-Flow-Across-the-Bot-Architecture.md`, `Entry-Price-Disambiguation-Plan.md`, `Price-Ambiguity-Codebase-Audit.md`, `Price-Model-and-Trade-Context-Architecture.md`, `Final-Price-Architecture-Review-and-Implementation-Plan.md`, `Price-Context-State-Lifecycle-and-Ownership-Architecture.md`, and `Phase-1-Complete-Price-Architecture-Review.md`).

It removes superseded findings, unifies terminology, maps component dependencies, and provides the definitive, single-source-of-truth roadmap for production implementation.

Zero code changes, database migrations, pseudocode, or file edits were performed. The codebase remains strictly frozen.

---

## 1. Consolidated Terminology & Domain Model

All Price Architecture documents have been harmonized under a single, unified terminology taxonomy:

```
+---------------------------------------------------------------------------------------------------+
| FIELD NAME            | DEFINITION & SSOT BINDING                       | DOMAIN OWNER            |
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

## 2. Cross-Document Architectural Consistency Matrix

All previous review documents have been cross-audited for 100% internal consistency:

```
+---------------------------------------------------------------------------------------------------+
| ARCHITECTURAL CONCEPT | SINGLE SOURCE OF TRUTH (SSOT) | WRITER MODULE         | READERS           |
+-----------------------+-------------------------------+-----------------------+-------------------+
| targetEntryPrice      | DO Storage KV (`targetEntry`) | Setup API / DO /activ | RiskEngine, Alert |
| signalPrice           | `TradingSignal.signalPrice`   | SignalEngine          | TradeAlert DTO, UI|
| executionPrice        | Order Execution Payload       | DO `/execute-trade`   | ExchangeAdapter   |
| averageFillPrice      | D1 `trade_positions.avg_fill` | Exchange Adapter Fill | Analytics, Position|
| stopLoss / takeProfit | `TradingSignal.stopLoss/TP`   | RiskEngine / Signal   | Alarm Loop, UI    |
| exitPrice             | D1 `trade_positions.close_px` | Position Monitor DO   | PnL Engine, Audit |
| positionSizeUsdt      | DO Storage KV (`posSizeUsdt`)| Setup API / DO /activ | Sizing Calculator |
+---------------------------------------------------------------------------------------------------+
```

---

## 3. Comprehensive Validation of 5 Core Architectural Issues

```
+---------------------------------------------------------------------------------------------------+
| PRIORITY 1: ENTRY PRICE AMBIGUITY                                            SEVERITY: CRITICAL  |
+---------------------------------------------------------------------------------------------------+
| Root Cause     | A single `entryPrice` / `entry_price` field was overloaded across user target,   |
|                | market signal price, and exchange fill price.                                    |
| Affected Comps | Android ViewModels, API DTOs, SignalEngine, TradingBot DO, D1 `trade_positions`.  |
| Affected Docs  | Entry-Price-Disambiguation-Plan, Price-Ambiguity-Codebase-Audit, Phase-1-Review.  |
| Agreed Solution| Disambiguate into `targetEntryPrice`, `signalPrice`, and `averageFillPrice`.      |
+---------------------------------------------------------------------------------------------------+

+---------------------------------------------------------------------------------------------------+
| PRIORITY 2: USER TARGET ENTRY PRICE LOST UPON ACTIVATION                      SEVERITY: CRITICAL  |
+---------------------------------------------------------------------------------------------------+
| Root Cause     | `/activate` handler parsed only `{ coinId, strategy, positionSize }`, discarding |
|                | the user's planned entry price before bot execution started.                     |
| Affected Comps | `exchange.ts` (`handleActivateTradingBot`), `TradingBot.fetch('/activate')`.      |
| Affected Docs  | Price-Model-and-Trade-Context-Architecture, Phase-1-Complete-Price-Review.        |
| Agreed Solution| Update activation payload & DO storage to persist `targetEntryPrice` in KV.       |
+---------------------------------------------------------------------------------------------------+

+---------------------------------------------------------------------------------------------------+
| PRIORITY 3: SL/TP CONSISTENCY BETWEEN SETUP & SIGNAL EXECUTION                  SEVERITY: HIGH    |
+---------------------------------------------------------------------------------------------------+
| Root Cause     | SignalEngine calculated SL/TP relative to live `currentPrice` at signal time,    |
|                | causing boundary shifts if market moved away from target entry.                  |
| Affected Comps | `SignalEngine.ts`, `RiskEngine.ts`, Android Trade Setup Preview.                  |
| Affected Docs  | Trade-Lifecycle-Architecture-Walkthrough, Price-Flow-Across-the-Bot.              |
| Agreed Solution| Base SL/TP on `targetEntryPrice` when limit order mode is active; calculate       |
|                | slippage breach (`|signalPrice - targetEntryPrice| / targetEntryPrice > max`).    |
+---------------------------------------------------------------------------------------------------+

+---------------------------------------------------------------------------------------------------+
| PRIORITY 4: ZERO FILL PRICE FALLBACK CORRUPTION                                  SEVERITY: HIGH    |
+---------------------------------------------------------------------------------------------------+
| Root Cause     | If an exchange order response returned `price: 0`, execution handler fell back to |
|                | `target.entryPrice` (signal price), writing corrupt fill prices to D1.            |
| Affected Comps | `TradingBot.fetch('/execute-trade')`, D1 `trade_positions`.                       |
| Affected Docs  | Price-Ambiguity-Codebase-Audit, Final-Price-Architecture-Review.                  |
| Agreed Solution| Issue a fallback ticker query (`adapter.fetchTicker(symbol)`) if fill price is 0. |
+---------------------------------------------------------------------------------------------------+

+---------------------------------------------------------------------------------------------------+
| PRIORITY 5: POSITION SIZE & ESTIMATED PNL AMBIGUITY                             SEVERITY: MEDIUM  |
+---------------------------------------------------------------------------------------------------+
| Root Cause     | `positionSize` was used ambiguously for quote (USDT) vs base (BTC) currency.     |
|                | `TradeAlert` hardcoded `estimatedPnl: 0`.                                         |
| Affected Comps | `TradingBot.alarm()`, `TradeAlert` DTO, `EngineAPIService.ts`.                    |
| Affected Docs  | Final-Price-Architecture-Review, Phase-1-Complete-Price-Review.                   |
| Agreed Solution| Explicitly name `positionSizeUsdt` in setup DTOs; calculate `estimatedPnl`        |
|                | using `(takeProfit - signalPrice) * quantity`.                                    |
+---------------------------------------------------------------------------------------------------+
```

---

## 4. Master Dependency Analysis

```
                                +-----------------------------------+
                                | Master Dependency Mapping         |
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

## 5. Master Implementation Roadmap (Sprints 16 - 19)

This single roadmap consolidates all task execution into 4 sequential, regression-minimized sprints:

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

## 6. Final Readiness Assessment & Freeze Declaration

* **Consolidation Status:** All Price Architecture documents are 100% consolidated.
* **Contradictions Status:** Zero remaining inconsistencies or conflicting recommendations.
* **Implementation Plan Completeness:** Complete, dependency-ordered, and risk-minimized.
* **Master Authority Declaration:** This document **officially supersedes all previous Price Architecture review documents** and will serve as the single, definitive implementation reference for Version 1.1.

```
+-----------------------------------------------------------------------------------+
|                        OFFICIAL PRICE ARCHITECTURE FREEZE                         |
+-----------------------------------------------------------------------------------+
| Price Architecture Freeze Status : OFFICIALLY FROZEN FOR VERSION 1.1              |
| Single Source of Truth           : Version-1.1-Price-Architecture-Master-Plan   |
+-----------------------------------------------------------------------------------+
```
