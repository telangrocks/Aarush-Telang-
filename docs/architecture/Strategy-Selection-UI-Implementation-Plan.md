# Strategy Selection UI — Implementation Plan & Readiness Report

> **Document Type:** Execution Blueprint & Implementation Readiness Report  
> **Target Version:** Version 1.1 Development Cycle  
> **Baseline Reference:** Version 1.0.0 Frozen Baseline (`6cedf18`, `Production-RC1`)  
> **Specification Reference:** `Strategy-Selection-Module-Walkthrough.md`  
> **Mode:** Readiness Review & Sprint Planning Only — Zero Code Modifications Performed  

---

## Executive Summary

This document establishes the definitive **Implementation Plan & Readiness Report** for the **Strategy Selection / Strategy Setup UI** module. 

A comprehensive read-only audit comparing the finalized specification (`Strategy-Selection-Module-Walkthrough.md`) against the frozen Version 1.0.0 codebase confirms that the backend strategy plugins, `StrategyRegistry`, `StrategyManifest`, and Durable Object state machine are **100% production-ready**. 

The implementation phase focuses on:
1. Cleaning up legacy gateway endpoint handlers in `exchange.ts` to expose dynamic manifests directly from `StrategyRegistry`.
2. Building the dynamic Android UI layer (Strategy Discovery, Selection Grid, Configuration Bottom Sheet, Confirmation Modal, and Active Monitoring integration).

No changes to the frozen Core Engine, `IStrategy` interface, or DTO contracts are required or permitted.

---

## 1. Current Implementation Status vs. Specification

| Module / Component | Specification Requirement | Current Codebase Status | Gap Assessment |
| :--- | :--- | :--- | :--- |
| **Strategy Manifests** | Strongly-typed `StrategyManifest` per strategy | Fully implemented in all 5 plugins (`Scalper V2`, `Momentum`, `Breakout`, `MeanReversion`, `VWAP`) | ✅ 100% Complete |
| **Strategy Registry** | Singleton exposing `getAllManifests()` & `getStrategy()` | Fully implemented in `StrategyRegistry.ts` | ✅ 100% Complete |
| **DO Strategy Endpoint** | `/strategies` returning `StrategyDiscoveryResponseDTO` | Implemented inside `TradingBot` DO (lines 568-576) | ✅ 100% Complete |
| **API Gateway Strategies** | `GET /api/exchange/strategies` returning manifests | Currently returns legacy hardcoded array in `exchange.ts` (lines 253-259) | ⚠️ **Gap:** Needs unification with `StrategyRegistry` |
| **Technical Analysis** | `POST /technical-analysis` pre-activation analysis | Uses legacy inline indicator math in `exchange.ts` (lines 363-456) | ⚠️ **Gap:** Needs migration to `StrategyOrchestrator` |
| **Android Strategy Discovery** | Dynamic UI driven by `StrategyManifestDTO` | Currently uses hardcoded client-side strategy lists | ⚠️ **Gap:** Needs dynamic DTO binding |
| **Android Configuration** | Timeframe & risk sliders with pre-validation | Basic UI; lacks dynamic bounds from manifest | ⚠️ **Gap:** Needs configuration bottom sheet |
| **Durable Object Activation** | `POST /activate` storing state & starting alarm | Fully implemented in `TradingBot` DO | ✅ 100% Complete |
| **Analysis Status Polling** | `GET /analysis-status` emitting engine DTO | Fully implemented via `EngineAPIService` | ✅ 100% Complete |

---

## 2. Gap Analysis & Technical Debt Identification

### Gap 1: Unification of Gateway `/api/exchange/strategies`
* **Current State:** `handleGetStrategies` in `backend/src/handlers/exchange.ts` returns a static array:
  `[{ id: "scalping", name: "Scalping", ... }, { id: "momentum", ... }]`
* **Required State:** Must return `StrategyDiscoveryResponseDTO` populated via `StrategyRegistry.getInstance().getAllManifests()`.
* **Impact:** High. Ensures new strategy plugins registered in `StrategyRegistry` are automatically discovered by clients without gateway code changes.

### Gap 2: Technical Analysis Endpoint Alignment
* **Current State:** `handleGetTechnicalAnalysis` in `exchange.ts` calls standalone `evaluateStrategy()` function using inline math.
* **Required State:** Must delegate evaluation to `StrategyOrchestrator` and `IndicatorEngine` to guarantee identical technical analysis results between pre-trade preview and background DO execution.
* **Impact:** Medium. Prevents pre-trade preview discrepancies.

### Gap 3: Android Dynamic Manifest Binding
* **Current State:** Android app UI relies on hardcoded string arrays for strategy names and descriptions.
* **Required State:** Android ViewModel queries `GET /api/exchange/strategies` on screen load and dynamically generates card views, category tabs, and timeframe chips from `StrategyManifestDTO`.
* **Impact:** High. Complete separation of presentation from business logic.

---

## 3. Architecture & Contract Alignment Check

The planned implementation strictly respects all frozen boundaries:

```
[Frozen Layer] Core Engine (Indicator, Condition, Confidence, Risk, Signal) -----> UNTOUCHED
[Frozen Layer] Plugin System (IStrategy, StrategyRegistry, StrategyManifest) -----> UNTOUCHED
[Frozen Layer] Android DTO Contracts (EngineStatus, MarketAnalysis, Signal)  -----> UNTOUCHED
[Frozen Layer] Durable Object Lifecycle (alarm, activate, analysis-status)  -----> UNTOUCHED

[Mutable Scope] Gateway Handler Unification (exchange.ts)                      -----> IN SCOPE
[Mutable Scope] Android UI Screens & ViewModels                                 -----> IN SCOPE
```

---

## 4. System Dependency Graph

```
                                +------------------------------+
                                | StrategyRegistry (Backend)   |
                                +------------------------------+
                                               |
                                               v
                                +------------------------------+
                                | GET /api/exchange/strategies |
                                +------------------------------+
                                               |
                                               v
                                +------------------------------+
                                | Android Strategy Repository  |
                                +------------------------------+
                                               |
                                               v
                                +------------------------------+
                                | StrategySelectionViewModel   |
                                +------------------------------+
                                               |
       +---------------------------------------+---------------------------------------+
       |                                       |                                       |
       v                                       v                                       v
+-------------------------------+   +-------------------------------+   +-------------------------------+
| StrategySelectionScreen       |   | StrategyConfigBottomSheet     |   | StrategyConfirmationDialog    |
| (Dynamic Cards & Filters)     |   | (Timeframe & Risk Sliders)    |   | (Pre-activation Summary)      |
+-------------------------------+   +-------------------------------+   +-------------------------------+
                                                                                       |
                                                                                       v
                                                                        +-------------------------------+
                                                                        | POST /api/exchange/bot/activate|
                                                                        +-------------------------------+
                                                                                       |
                                                                                       v
                                                                        +-------------------------------+
                                                                        | ActiveMonitoringScreen        |
                                                                        | (GET /bot/analysis-status)    |
                                                                        +-------------------------------+
```

---

## 5. Professional Platform UX Benchmarking

Comparing our planned Strategy Setup flow against industry leaders (QuantConnect, 3Commas, TradingView, MetaTrader 5):

| Feature | 3Commas / Capitalise.ai | MetaTrader 5 | Planned CryptoPulse v1.1 UI | Design Objective |
| :--- | :--- | :--- | :--- | :--- |
| **Strategy Discovery** | Fixed Bot Types | File-based EAs | Dynamic Category Tabs (`ALL`, `SCALPING`, `MOMENTUM`, `REVERSION`, `INSTITUTIONAL`) | Fast filtering by market regime |
| **Risk Transparency** | Basic % input | Hidden in EA code | Explicit Risk Badges (`Low`, `Medium`, `High`) & ATR Stop-Loss Multipliers | High transparency & user confidence |
| **Pre-Trade Validation** | Minimal pre-check | Manual backtest | Live Checkpoint Progress Bar & Real-time Indicator Confirmation | Immediate visual feedback before activation |
| **Activation Feedback** | Toast message | Terminal log | Structured Confirmation Modal + Instant Status Transition | Zero ambiguity on bot execution state |

---

## 6. Sprint Implementation Breakdown

The implementation is divided into **four incremental, non-breaking sprints**.

### Sprint 16 — Backend Gateway Unification & Manifest Wiring

* **Objective:** Replace legacy static strategy handlers with dynamic `StrategyRegistry` manifests.
* **Scope:**
  * Update `handleGetStrategies` in `backend/src/handlers/exchange.ts` to return `StrategyDiscoveryResponseDTO` from `StrategyRegistry.getInstance().getAllManifests()`.
  * Update `handleGetTechnicalAnalysis` in `backend/src/handlers/exchange.ts` to utilize `IndicatorEngine` / `StrategyOrchestrator`.
  * Write gateway API integration tests verifying dynamic manifest serialization.
* **Files to Modify:**
  * `backend/src/handlers/exchange.ts`
  * `backend/tests/api/API.test.ts`
* **Dependencies:** None.
* **Validation Plan:** `npm run build && npx vitest run tests/api/API.test.ts`.
* **Definition of Done:** Gateway endpoint `/api/exchange/strategies` outputs all 5 registered strategy manifests (`ScalperV2`, `Momentum`, `Breakout`, `MeanReversion`, `VWAP`) matching `StrategyManifestDTO` schema.

---

### Sprint 17 — Android Strategy Discovery & Selection Screen

* **Objective:** Implement dynamic Strategy Selection Screen in Android client driven by API manifests.
* **Scope:**
  * Implement `StrategyRepository.getStrategies()` to consume `GET /api/exchange/strategies`.
  * Create `StrategySelectionViewModel` managing loading, error, empty, and strategy list states.
  * Build UI composables/views: `StrategyCategoryTabs`, `StrategyCard`, `RiskBadge`, `TimeframeChipGroup`.
  * Support category filtering (`ALL`, `SCALPING`, `MOMENTUM`, `REVERSION`, `INSTITUTIONAL`).
* **Files to Create/Modify (Android):**
  * `data/repository/StrategyRepository.kt`
  * `ui/selection/StrategySelectionViewModel.kt`
  * `ui/selection/StrategySelectionScreen.kt`
  * `ui/components/StrategyCard.kt`
* **Dependencies:** Sprint 16 completion.
* **Validation Plan:** UI unit tests + UI preview rendering with mock manifest DTOs.
* **Definition of Done:** Android app displays strategy cards dynamically generated from API manifests with functioning category tabs and timeframe chips.

---

### Sprint 18 — Android Dynamic Strategy Configuration & Confirmation Modal

* **Objective:** Build the parameter configuration bottom sheet and confirmation modal.
* **Scope:**
  * Create `StrategyConfigBottomSheet` rendering timeframe selector and account risk percentage slider (0.1% to 5.0%).
  * Implement client-side validation (`minNotional`, supported timeframe check).
  * Build `StrategyConfirmationDialog` displaying pair, strategy ID, stop-loss rules, and maximum position size.
  * Connect activation trigger to `POST /api/exchange/bot/activate`.
* **Files to Create/Modify (Android):**
  * `ui/config/StrategyConfigBottomSheet.kt`
  * `ui/config/StrategyConfirmationDialog.kt`
  * `ui/selection/StrategySelectionViewModel.kt`
* **Dependencies:** Sprint 17 completion.
* **Validation Plan:** Form validation unit tests + mock API activation call tests.
* **Definition of Done:** User can adjust risk parameters, select timeframes, pass pre-activation validation, and dispatch `/activate` request with loading feedback.

---

### Sprint 19 — End-to-End Activation Flow & Monitoring Integration

* **Objective:** Complete full activation lifecycle and seamless transition to Active Monitoring.
* **Scope:**
  * Connect activation success response to automatic navigation: `StrategySelectionScreen -> ActiveMonitoringScreen`.
  * Bind `GET /api/exchange/bot/analysis-status` polling to live confidence gauge and condition status checklist.
  * Implement error recovery, retry snackbars, and session restoration (reopening app detects `isActive: true`).
* **Files to Create/Modify (Android):**
  * `ui/monitoring/ActiveMonitoringScreen.kt`
  * `ui/navigation/NavGraph.kt`
* **Dependencies:** Sprint 18 completion.
* **Validation Plan:** End-to-end integration test from strategy selection to active status polling against local Workers dev server (`wrangler dev`).
* **Definition of Done:** Selecting a strategy, configuring risk, confirming, and activating transitions cleanly to live monitoring displaying real-time engine DTO updates.

---

## 7. Risk Assessment & Mitigation Matrix

| Identified Risk | Likelihood | Impact | Mitigation Strategy |
| :--- | :---: | :---: | :--- |
| **Android DTO Deserialization Mismatch** | Low | High | Enforce strict Kotlin `@Serializable` data classes matching backend `StrategyManifestDTO` & `AndroidIntegrationContract`. |
| **Duplicate Activation Requests** | Medium | Medium | Lock activation CTA button in loading state upon first click; DO `isExecutingTrade` flag rejects concurrent calls. |
| **Network Failure During Activation** | Medium | Medium | Retain selected configuration in ViewModel state; allow immediate 1-tap retry via Snackbar without re-entering parameters. |
| **Unsupported Timeframe Selection** | Low | Medium | Client UI dynamically disables timeframe chips not present in `manifest.supportedTimeframes`. |
| **Cold DO Start Latency** | Low | Low | API Gateway handles DO fetching asynchronously; UI displays indeterminate loading spinner during activation call. |

---

## 8. Final Acceptance Criteria & Verification Checklist

### Pre-Implementation Checklist:
- [x] Version 1.0.0 Baseline frozen and tagged (`Version-1.0.0`).
- [x] Architectural Specification finalized (`Strategy-Selection-Module-Walkthrough.md`).
- [x] Implementation Plan reviewed and approved.

### End-to-End Release Acceptance Criteria (Post-Sprint 19):
1. **Zero Hardcoded Strategies:** `GET /api/exchange/strategies` outputs dynamic manifests directly from `StrategyRegistry`.
2. **Dynamic UI Rendering:** Adding a new strategy plugin to the backend automatically renders a new strategy card in the Android app.
3. **Pure Presentation Layer:** Android app contains 0 indicator calculations or trading logic; renders DTOs verbatim.
4. **Clean Navigation:** Selecting strategy -> configuring -> confirming -> activating transitions smoothly to live monitoring view.
5. **Session Recovery:** Re-opening the Android app while a bot is running automatically restores the Active Monitoring screen.
6. **Regression Protection:** All existing 59 unit/stress/reliability backend tests continue to pass with 0 errors.

---

## Conclusion & Next Steps

This Implementation Plan provides the execution blueprint for the Strategy Selection UI. 

Implementation will proceed sequentially through **Sprint 16** (Backend Gateway Unification), **Sprint 17** (Android Discovery UI), **Sprint 18** (Configuration & Confirmation), and **Sprint 19** (End-to-End Monitoring Integration).
