# Entry Price Disambiguation — Architectural Implementation Plan

> **Document Type:** Architectural Analysis & Refinement Blueprint  
> **Target Release:** Post-v1.0.0 Refinement (v1.1 Architectural Alignment)  
> **Status:** Planning & Analysis Only — Zero Code Modifications Performed  

---

## 1. Problem Statement & Root Cause Analysis

### Current Issue
In the current Version 1.0.0 codebase, the term and field name `entryPrice` is overloaded across multiple operational contexts:

1. **User-Entered Target Entry Price:** The price entered by the user on the Android Trade Setup screen (e.g., 50,000 USDT) representing their desired or planned entry price.
2. **Strategy-Generated Signal Price:** The live market price (`MarketSnapshot.currentPrice`) at the exact second a strategy plugin and `SignalEngine` produce a valid `TradingSignal` (`hasSignal == true`).
3. **Exchange Execution Fill Price:** The actual filled order price returned by the exchange execution API and written to D1 `trade_positions.entry_price`.

### Architectural Risks & Potential Failure Modes

```
+-----------------------------------------------------------------------------------+
|                         CONFLATION RISKS & SLIPPAGE BUG                           |
+-----------------------------------------------------------------------------------+
| Scenario:                                                                         |
| 1. User sets Target Entry Price = 50,000 USDT on Trade Setup Screen.              |
| 2. Strategy runs 10 minutes later when Live Market Price = 50,500 USDT.           |
| 3. SignalEngine sets Signal Entry Price = 50,500 USDT.                            |
|                                                                                   |
| Current Behavior (Field Conflation):                                              |
| The backend overwrites `entryPrice` with 50,500 USDT on `TradeAlert`.             |
|                                                                                   |
| Consequences:                                                                     |
| - The system loses track of the user's original 50,000 USDT target entry.         |
| - SL/TP calculated relative to 50,500 instead of user's target 50,000.            |
| - Cannot measure entry slippage (|SignalPrice - TargetEntryPrice|).               |
| - Over-extension checks fail to detect when market has moved away from user target|
+-----------------------------------------------------------------------------------+
```

---

## 2. Proposed Architectural Solution

We propose introducing explicit, domain-bound naming conventions across all layers of the platform:

```
+-----------------------------------------------------------------------------------+
|                        PROPOSED DISAMBIGUATED TERMINOLOGY                         |
+-----------------------------------------------------------------------------------+
| 1. targetEntryPrice : User-specified desired entry price (Set during Trade Setup).|
| 2. signalPrice      : Live market price when strategy generated the trade signal. |
| 3. fillPrice        : Actual order fill price returned by exchange order response.|
+-----------------------------------------------------------------------------------+
```

### Domain Mapping Table:

| Layer / Object | Old Overloaded Field | New Disambiguated Field | Definition & Responsibility |
| :--- | :--- | :--- | :--- |
| **Android Setup Form** | `entryPrice` | `targetEntryPrice` | User-defined target entry price. |
| **`BotActivationPayload`** | `entryPrice` (optional) | `targetEntryPrice` | Optional target price sent to DO `/activate`. |
| **DO Storage** | `entryPrice` | `targetEntryPrice` | Stored in DO KV memory alongside `coinId`. |
| **`RiskContext`** | `currentPrice` | `currentPrice` / `targetEntryPrice` | Used for ATR distance & sizing calculations. |
| **`TradingSignal`** | `entryPrice` | `signalPrice` | Market price when signal was generated. |
| **`TradeAlert` DTO** | `entryPrice` | `signalPrice` & `targetEntryPrice` | Contains **both** prices for user transparency. |
| **D1 `trade_positions`**| `entry_price` | `fill_price` (and `target_entry_price`)| Records filled price & target for analytics. |

---

## 3. Disambiguated Data Schemas

### 3.1 `TradingSignal` (Engine Output):
```typescript
export interface TradingSignal {
  symbol: string;
  timeframe: Timeframe;
  type: SignalType;
  confidenceScore: number;
  riskAssessment: RiskAssessment | null;
  signalPrice: number | null;        // Explicit market price at signal generation
  targetEntryPrice?: number | null; // User's planned entry price (if set)
  stopLoss: number | null;          // Calculated SL relative to target/signal price
  takeProfit: number | null;        // Calculated TP relative to target/signal price
  reasoning: string[];
  timestamp: number;
}
```

### 3.2 `TradeAlert` (Notification DTO):
```typescript
export interface TradeAlert {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  signalPrice: number;              // Market price when alert was triggered
  targetEntryPrice?: number;        // User's target entry price from setup
  stopLoss: number;                 // Stop loss bound
  takeProfit: number;               // Take profit bound
  estimatedPnl: number;             // Expected PnL based on targetEntryPrice vs TP
  positionSize: number;             // Risk-sized position amount
  strategy: string;                 // Active strategy ID
  timestamp: string;
  status: 'pending' | 'acknowledged' | 'executed' | 'expired';
}
```

---

## 4. Impact Analysis & Component Scope

```
                                +------------------------------+
                                | Affected Components Matrix   |
                                +------------------------------+
                                               |
       +-------------------+-------------------+-------------------+-------------------+
       |                   |                   |                   |                   |
       v                   v                   v                   v                   v
[Android Setup UI]  [API Activation DTO] [Durable Object Storage] [Signal Engine]   [D1 Schema & DB]
  - Target entry      - Renames field     - Stores target     - Generates         - Adds target_entry
  - SL/TP preview     - Backward compat   - Compares vs.      - Sets signalPrice  - Renames to
    calculations        layer               signalPrice                             fill_price
```

### Detailed Component Impact Breakdown:

1. **Android Trade Setup Screen & ViewModels:**
   * Rename UI state property to `targetEntryPrice`.
   * Pre-trade SL/TP preview calculations explicitly compute `SL = targetEntryPrice - (1.5 * ATR)`.
2. **API Gateway & Activation Payload:**
   * `POST /bot/activate` payload adds optional `targetEntryPrice: number`.
3. **Cloudflare Durable Object (`TradingBot`):**
   * Persists `targetEntryPrice` in KV storage (`await this.state.storage.put('targetEntryPrice', targetEntryPrice)`).
   * Passes `targetEntryPrice` into strategy evaluation cycle.
   * Assembles `TradeAlert` containing both `signalPrice` and `targetEntryPrice`.
4. **Signal Engine & Risk Engine:**
   * `SignalEngine` sets `signalPrice = context.currentPrice`.
   * Uses `targetEntryPrice` (if provided) or `signalPrice` as the reference for `stopLoss` and `takeProfit` distances.
5. **Database Schema (D1):**
   * Migration script adds column `target_entry_price REAL` to `trade_positions`.
   * Alias `entry_price` as `fill_price` in query responses.

---

## 5. End-to-End Data Flow (Before vs. After)

### Before (Ambiguous Conflated Flow):
```
User inputs 50000 -> Stored as entryPrice -> Signal fires at 50500 -> Overwrites entryPrice = 50500 -> Fill at 50505 -> Stored as entry_price = 50505
```
*(User's 50,000 target is permanently lost)*

### After (Explicit Disambiguated Flow):
```
User inputs 50000 (targetEntryPrice) 
       │
       ▼
Stored in DO Storage as targetEntryPrice = 50000
       │
       ▼
Signal fires at 50500 (signalPrice)
       │
       ▼
TradeAlert generated with { targetEntryPrice: 50000, signalPrice: 50500, slippage: +1.0% }
       │
       ▼
User confirms trade -> Exchange fills order at 50505 (fillPrice)
       │
       ▼
D1 Database records: target_entry_price = 50000, fill_price = 50505
```

---

## 6. Backward Compatibility Strategy

To ensure zero downtime or client breakage during rollout, the backend will implement a **2-stage deprecation layer**:

```typescript
// Compatibility Transformer in EngineAPIService.ts
export function normalizeTradeAlert(rawAlert: any): TradeAlert {
  return {
    ...rawAlert,
    // Disambiguated fields
    signalPrice: rawAlert.signalPrice ?? rawAlert.entryPrice ?? 0,
    targetEntryPrice: rawAlert.targetEntryPrice ?? rawAlert.entryPrice ?? null,
    // Deprecated legacy field maintained for v1.0 Android clients
    entryPrice: rawAlert.signalPrice ?? rawAlert.entryPrice ?? 0
  };
}
```

* Legacy `v1.0` Android clients continue reading `entryPrice`.
* Refactored `v1.1` Android clients read explicit `signalPrice` and `targetEntryPrice`.

---

## 7. Risks, Dependencies, and Edge Cases

1. **Missing Target Entry Price (Market Order Mode):**
   * *Scenario:* User activates bot in pure market-following mode without specifying a target entry price.
   * *Handling:* `targetEntryPrice` is set to `null`. `SignalEngine` falls back to using `signalPrice` for SL/TP calculations.
2. **Extreme Entry Slippage:**
   * *Scenario:* `signalPrice` is 5% higher than user's `targetEntryPrice`.
   * *Handling:* `RiskEngine` detects slippage breach (`|signalPrice - targetEntryPrice| / targetEntryPrice > maxSlippageThreshold`) and suppresses signal generation (`SignalType.HOLD`).
3. **Database Migration Safety:**
   * *Scenario:* Updating production D1 database schema.
   * *Handling:* Use non-destructive `ALTER TABLE trade_positions ADD COLUMN target_entry_price REAL;` migration without dropping existing columns.

---

## 8. Phased Implementation Strategy

We recommend executing this disambiguation across **three small, controlled phases**:

```
+-----------------------------------------------------------------------------------+
| PHASE 1: Engine & DTO Schema Disambiguation (Backend)                             |
| - Introduce `signalPrice` & `targetEntryPrice` in DTOs and SignalEngine           |
| - Add backward-compatibility getter in EngineAPIService                           |
| - Zero impact on Android UI                                                       |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| PHASE 2: Durable Object & D1 Database Schema Update                               |
| - Add D1 migration for `target_entry_price` column in `trade_positions`           |
| - Store `targetEntryPrice` in DO KV storage upon `/activate`                      |
| - Implement slippage check in RiskEngine                                          |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| PHASE 3: Android Setup UI & Alert Popup Disambiguation                            |
| - Update `TradeSetupViewModel` to pass `targetEntryPrice`                         |
| - Update Trade Alert Popup to display both Planned Entry & Market Signal Price    |
| - Display slippage delta percentage on confirmation modal                         |
+-----------------------------------------------------------------------------------+
```

---

## Conclusion & Next Steps

This Implementation Plan resolves the **Entry Price Ambiguity** cleanly while preserving the frozen Version 1.0.0 Core Engine logic. 

Please review this plan. Upon your approval, we will incorporate these disambiguated DTO schemas into the upcoming `v1.1` sprint roadmap before writing any production code.
