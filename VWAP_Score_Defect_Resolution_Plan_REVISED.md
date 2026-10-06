STATUS: READ-ONLY PLAN — IMPLEMENTATION NOT AUTHORIZED

# CRYPTOPULSE — REVISED VWAP SCORE DEFECT RESOLUTION PLAN

---

## 1. REPOSITORY INTEGRITY

```text
================================================================================
REPOSITORY INTEGRITY ATTESTATION
================================================================================
Repository Root       : C:\CryptoPulse New
Branch                : main
Current HEAD Commit   : a92847eeede1f0bd8fa313babe9169d4fb505630
Working-Tree State    : Preserved exactly from prior sessions; zero changes made.
Files Modified        : 0
Files Created         : 0 (Plan document only)
Files Deleted         : 0
Migrations Applied    : 0
Deployments           : 0
================================================================================
```

> **Mandatory Declaration:** No existing source, test, or mobile changes were created, reverted, cleaned, stashed, or modified during this verification pass. The working tree remains completely untouched.

---

## 2. CONFIRMED FINDINGS & EXISTING DEFECT RE-VERIFICATION

### 2.1 DEFECT-VWAP-01 — Backend VWAP No-Signal Score Loss
- **File & Lines:** `backend/src/engine/strategies/vwap/VWAPStrategy.ts` (lines 287–310)
- **Forensic Fact:** In `VWAPStrategy.ts` line 92:
  ```typescript
  const confidenceScore = this.confidenceEngine.evaluate(conditionResult);
  ```
  `ConfidenceEngine` computes a fully populated, valid `ConfidenceScore` object containing `overallScore`, `timeframes['15m'].score`, `longScore`, and `shortScore`.
- **The Defect:** When any entry prerequisite fails (price extended at line 124, sideways market at line 130, low volume at line 142, or no definitive VWAP crossover at line 184), the method exits via `this.createNoSignalResult(...)`.
  Inside `createNoSignalResult()` (lines 295–310):
  ```typescript
  return {
    strategyId: this.manifest.id,
    timestamp: context.timestamp,
    confidenceScore: 0,               // <--- Hardcoded zero
    hasSignal: false,
    metadata: {
      reasoning,
      signal: null,
      targetTimeframe,
      indicatorSnapshot: ...,
      conditionResult: ...,
      strategyConfig: this.config,
      // <--- metadata.confidenceScore is completely dropped
      customIndicators: customIndicators || []
    }
  };
  ```
- **Distinct Analytical vs. Fail-Closed Paths:**
  1. **Legitimate Analytical No-Signal Paths (Score Must Be Preserved):**
     - Price overextended away from VWAP (>3.0%) (line 124)
     - Sideways chop market (<0.2% displacement) (line 130)
     - Low volume rejection (<1.5x average) (line 142)
     - No definitive VWAP crossover (line 184)
     *In all four cases, candles are fully formed and closed, indicators and conditions have successfully evaluated, and a valid `ConfidenceScore` is in memory.*
  2. **Early Fail-Closed Paths (Must Continue Returning 0):**
     - Unsupported timeframe (line 57)
     - Missing candle data (line 62)
     - Insufficient candle data (<2 closed candles) (line 71)
     - Invalid / non-positive price (line 102)
     - Zero / unconfigured account balance (line 107)
     - Indicator calculation failure on target timeframe (line 113)
     *In these six cases, data is corrupt, unavailable, or invalid; returning `0` is the correct fail-closed response.*

---

## 3. CONFIDENCESCORE CONTRACT ACROSS CRYPTOPULSE

### 3.1 Intended Semantic Meaning
Across CryptoPulse, `EvaluationResult` has two distinct properties with independent semantics:

1. **`hasSignal: boolean` represents Trade Entry Intent:**
   - `true`: A valid entry setup has fired and qualified through all risk, regime, and confidence gates.
   - `false`: No entry signal exists on this candle.
2. **`confidenceScore: number` represents Technical Market Health / Analytical Score:**
   - When `hasSignal: true`: It represents the directional entry score (longScore for BUY, shortScore for SELL).
   - When `hasSignal: false`: It represents the multi-factor analytical health score of the target timeframe indicators (`primaryTfConfidence.score`), bounded in `[0, 100]`.
   - When indicators cannot be calculated (missing candles, invalid price, unsupported timeframe): It is `0` or `null`.

### 3.2 Evidence from the Other Four Strategies
In all four other production strategies, `confidenceScore` is explicitly preserved during ordinary no-signal bars:
- **ScalperV2** (`ScalperV2Strategy.ts` line 239):
  ```typescript
  directionalConfidence = activeSignal?.type === SignalType.SELL ? ... : activeSignal?.type === SignalType.BUY ? ... : (primaryTfConfidence?.score ?? 0);
  ```
- **Momentum** (`MomentumStrategy.ts` line 321):
  ```typescript
  directionalConfidence = activeSignal?.type === SignalType.SELL ? ... : activeSignal?.type === SignalType.BUY ? ... : (primaryTfConfidence?.score ?? 0);
  ```
- **Breakout** (`BreakoutStrategy.ts` line 332):
  ```typescript
  directionalConfidence = activeSignal?.type === SignalType.SELL ? ... : activeSignal?.type === SignalType.BUY ? ... : (primaryTfConfidence?.score ?? 0);
  ```
- **MeanReversion** (`MeanReversionStrategy.ts` line 290):
  ```typescript
  const directionalConfidence = (primaryTfConfidence?.score ?? 0);
  ```

---

## 4. FIVE-STRATEGY COMPARISON

| Strategy | No-Signal Path Trigger | Confidence Source | No-Signal Score | Metadata Score Preserved? | Android Card Display |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **ScalperV2** | Condition not qualified | `primaryTfConfidence.score` | **50–85** | YES | Active score (e.g. `78 / 100`), cyan progress bar |
| **Momentum** | Trend not aligned | `primaryTfConfidence.score` | **50–85** | YES | Active score (e.g. `68 / 100`), cyan progress bar |
| **Breakout** | S/R not broken | `primaryTfConfidence.score` | **50–85** | YES | Active score (e.g. `73 / 100`), cyan progress bar |
| **MeanReversion** | 2-step curl not met | `primaryTfConfidence.score` | **50–85** | YES | Active score (e.g. `62 / 100`), cyan progress bar |
| **VWAP (Current)** | No crossover / chop / volume | `createNoSignalResult()` | **0** | **NO** | Flawed `"0 / 100"`, empty bar, `"NOT MET"` |
| **VWAP (Proposed)**| No crossover / chop / volume | `primaryTfConfidence.score` | **50–85** | **YES** | Active score (e.g. `74 / 100`), cyan progress bar |

---

## 5. SURGICAL BACKEND VWAP FIX PLAN

### 5.1 Target File & Method
- **File:** `backend/src/engine/strategies/vwap/VWAPStrategy.ts`
- **Import:** Add `ConfidenceScore` to line 7 imports from `'../../confidence'`:
  ```typescript
  import { ConfidenceEngine, ConfidenceScore } from '../../confidence';
  ```
- **Method:** `createNoSignalResult()` (lines 287–310).

### 5.2 Desired Surgical Implementation (100% Type-Safe)
```typescript
private createNoSignalResult(
  context: Readonly<StrategyContext>,
  reasoning: string[],
  targetTimeframe?: Timeframe,
  indicatorSnapshot?: any,
  conditionResult?: any,
  confidenceScore?: ConfidenceScore,            // Strongly-typed ConfidenceScore
  customIndicators?: any[]
): EvaluationResult {
  const tfConf = targetTimeframe && confidenceScore?.timeframes?.[targetTimeframe];
  const resolvedScore = tfConf?.score ?? confidenceScore?.overallScore ?? 0;

  return {
    strategyId: this.manifest.id,
    timestamp: context.timestamp,
    confidenceScore: resolvedScore,             // Preserves live indicator score
    hasSignal: false,
    metadata: {
      reasoning,
      signal: null,
      targetTimeframe,
      indicatorSnapshot: indicatorSnapshot || { timestamp: context.timestamp, timeframes: {} },
      conditionResult: conditionResult || { timestamp: context.timestamp, overallPass: false, totalConditions: 0, passedConditions: 0, conditions: [] },
      confidenceScore: confidenceScore || null, // Preserved in metadata
      strategyConfig: this.config,
      customIndicators: customIndicators || []
    }
  };
}
```

### 5.3 Callsites in `VWAPStrategy.evaluate()`:
- **Line 124 (Overextended):** Pass `confidenceScore`
- **Line 130 (Sideways chop):** Pass `confidenceScore`
- **Line 142 (Low volume):** Pass `confidenceScore`
- **Line 184 (No crossover):** Pass `confidenceScore`, `customIndicators`
- **Early fail-closed gates (lines 57, 62, 71, 102, 107, 113):** Do not pass `confidenceScore`; it defaults to `undefined`, resolving `resolvedScore = 0`.

---

## 6. DOWNSTREAM EXECUTION-SAFETY AUDIT (MANDATORY)

### The Core Safety Question:
> **If VWAP returns `hasSignal: false` but `confidenceScore` changes from `0` to `74`, can that `74` ever cause a TradeAlert, candidate ranking change, alert selection, WAL intent, or Bybit execution?**

### The Definitive Forensic Answer:
**ABSOLUTELY NOT.** Direct source code tracing across `StrategyOrchestrator.ts`, `trading-bot.ts`, `MarketOpportunityScanner.ts`, `FinalDispatchSafetyGate.ts`, and the WAL subsystem proves that non-signal evaluations are mathematically isolated from live trading by strict, immutable fail-closed gates.

---

## 7. STRATEGYORCHESTRATOR TRACE

In `backend/src/engine/orchestrator/StrategyOrchestrator.ts`:
1. **Signal Tallying (lines 106–117):**
   ```typescript
   const tallySignal = (result: EvaluationResult | null, success: boolean) => {
     if (success) {
       successfulEvaluations++;
       if (result?.hasSignal && result.metadata?.signal) {
         const sigType = result.metadata.signal.type;
         if (sigType === 'BUY') buySignals++;
         else if (sigType === 'SELL') sellSignals++;
       }
     } else {
       failedEvaluations++;
     }
   };
   ```
   If `result.hasSignal === false`, `buySignals` and `sellSignals` are **never** incremented, regardless of `confidenceScore`.
2. **Telemetry Dispatch (lines 193–214):**
   ```typescript
   if (result.hasSignal && telemetryContext?.userId && telemetryContext?.sink) {
     telemetryContext.sink.emit({
       eventName: 'STRATEGY_EVALUATION',
       ...
     });
   }
   ```
   Diagnostic telemetry only emits `STRATEGY_EVALUATION` if `result.hasSignal === true`.
3. **Execution Absence:**
   `StrategyOrchestrator` contains **zero** order dispatch, alert creation, WAL, or execution logic. It simply returns `results: EvaluationResult[]`.

---

## 8. TRADING-BOT DOWNSTREAM TRACE

In `backend/src/trading-bot.ts`:

### 8.1 UI Persistence vs. Execution Split (lines 2841–2858)
At line 2844, `results` are mapped into `newAnalysis.strategyAnalyses` strictly for UI presentation and stored in Durable Object storage (`await this.state.storage.put('newAnalysis', newAnalysis)`). This path has zero interaction with trading.

### 8.2 The Actionable Signal Gate (lines 2864–2869)
```typescript
let actionableResults = results.filter(r => {
  if (!r?.hasSignal || !r.metadata?.signal) return false;
  if (!normalizedCommitted) return true;
  const normalizedCand = registry.normalizeStrategyId(r.strategyId).toLowerCase();
  return normalizedCand === normalizedCommitted;
});
```
- **Forensic Proof:** Line 2865 is an absolute filter:
  `if (!r?.hasSignal || !r.metadata?.signal) return false;`
- If `r.hasSignal === false` or `r.metadata.signal === null`, the result is **instantly dropped**.
- **A VWAP result with `hasSignal: false` and `confidenceScore: 74` CANNOT enter `actionableResults`.**

---

## 9. ALERT / RANKING / COALESCING TRACE

### 9.1 Multi-Timeframe Coalescing (lines 2873–2876)
```typescript
if (actionableResults.length > 1) {
  actionableResults.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));
  actionableResults = [actionableResults[0]];
}
```
- **Forensic Proof:** The sorting and coalescing logic operates **only on `actionableResults`**.
- Because non-signal results were already eliminated at line 2865, a non-signal VWAP result **never participates in sorting or coalescing**.

### 9.2 Alert Creation Loop (lines 2878–2885)
```typescript
for (const result of actionableResults) {
  if (result?.hasSignal && result.metadata?.signal) {
    const sig = result.metadata.signal;
    ...
    alerts.push(alert);
    await this.persistState('alerts', this.pruneAlerts(alerts));
```
- Line 2879 repeats the check: `if (result?.hasSignal && result.metadata?.signal)`.
- Without `hasSignal === true` and an active `TradingSignal` object, an alert **cannot be constructed**.

### 9.3 Diagnostic & FCM Dispatches (lines 3150 & 3170)
Lines 3150 (`confidenceScore: Math.round(result.confidenceScore || 0)`) and 3170 (`confidenceScore: result.confidenceScore || 0`) are located entirely inside the `for (const result of actionableResults)` loop. They only execute for alerts that have already passed all qualification gates.

---

## 10. EXECUTION / WAL / BYBIT SAFETY PROOF

Order execution in `trading-bot.ts` occurs under the `/execute-trade` endpoint (lines 1275–1950):
1. **Target Alert Lookup (lines 1282–1320):**
   Requires an existing `alertId`. Looks up `target: TradeAlert` in `this.runtimeState.alerts`.
   If no alert exists, line 1319 returns `409 Conflict: Trade alert not found`.
2. **Signal Verification (lines 1343–1370):**
   Verifies `target.side`, strategy manifest, short capability.
3. **Safety Gates (lines 1433–1673):**
   - Active intent conflict gate (line 1438)
   - Position conflict gate (line 1603)
   - Portfolio exposure gate (line 1659)
4. **Execution Snapshot & WAL (lines 1806–1876):**
   Constructs `TradeExecutionSnapshot` from `target.id` and persists intent to WAL with status `'INTENT_PERSISTED'`.
5. **Final Dispatch Safety Gate (lines 1858–1873):**
   `FinalDispatchSafetyGate.validate(req, ...)` validates quantization and exposure.
6. **Exchange Dispatch (lines 1910–1950):**
   Dispatches via `adapter.createOrder(req)`.

**Forensic Conclusion:** The execution pipeline requires an existing `TradeAlert` ID. Since a `hasSignal: false` evaluation cannot produce a `TradeAlert`, it is architecturally and mathematically impossible for a no-signal evaluation to trigger a WAL intent or reach Bybit execution.

---

## 11. COMPLETE END-TO-END DATA-FLOW DIAGRAM

```text
VWAPStrategy.evaluate(context, targetTimeframe)
       │
       ├── Closed candles & indicators valid
       ├── ConfidenceEngine.evaluate() ──> target TF score = 74
       │
       ├── Legitimate analytical branch:
       │   [No crossover / Chop / Low volume / Overextended]
       │
       ▼
EvaluationResult
       ├── strategyId: 'VWAP'
       ├── hasSignal: false
       ├── confidenceScore: 74
       └── metadata: { signal: null, confidenceScore: ConfidenceScore, ... }
               │
               ▼
StrategyOrchestrator.executeCycle()
       │
       ├── tallySignal() ──> hasSignal === false ──> buySignals/sellSignals NOT incremented
       ├── evaluateWithTelemetry() ──> hasSignal === false ──> STRATEGY_EVALUATION NOT emitted
       │
       ▼
trading-bot.ts (executeCycle)
       │
       ├── [PATH 1: UI PRESENTATION]
       │   └── AnalysisSnapshotMapper.mapStrategyEvaluations(results)
       │       └── VWAP evaluation: confidenceScore = 74
       │           └── Persisted in newAnalysis.strategyAnalyses
       │               └── Android UI renders: "74 / 100" with cyan progress bar
       │
       └── [PATH 2: LIVE EXECUTION PIPELINE]
           │
           └── actionableResults = results.filter(r => r.hasSignal && r.metadata.signal)
                   │
                   ▼ (r.hasSignal === false)
               DROPPED AT LINE 2865
                   │
                   ├── NEVER enters actionableResults
                   ├── NEVER sorted or coalesced in multi-TF ranking (line 2874)
                   ├── NEVER enters alert creation loop (line 2878)
                   │
                   ▼
               NO TradeAlert created
                   │
                   ▼
               NO active alert in runtimeState.alerts
                   │
                   ▼
               NO /execute-trade match
                   │
                   ▼
               NO WAL intent persisted
                   │
                   ▼
               NO Bybit order dispatched
```

---

## 12. ANDROID CLIENT IMPACT

- **No Android Source Code Change Required.**
- In `AnalysisSnapshotDto.kt` (line 73) and `BotMapper.kt` (line 70), Android already parses `confidenceScore: Int?`.
- In `TechnicalAnalysisScreen.kt` (line 410), `StrategyScoreCard` already renders `"$score / 100"` whenever `score` is a non-zero integer.
- In preview mode, `resolveMarketCondition` receives `marketAnalysis.confidenceScore`. When the score is `74` instead of `0`, line 176 passes and unfreezes the preview card from `"ANALYZING..."`.

---

## 13. PREVIEW ENDPOINT SCOPE (DEFECT-VWAP-03)

- `handleGetTechnicalAnalysis` (`exchange.ts` lines 1562–1592) is a single-strategy on-demand preview path.
- The absence of `strategyAnalyses` in single-strategy preview affects **all five strategies** equally when the bot is stopped.
- This is an endpoint boundary characteristic, not a VWAP-specific bug. It must remain strictly isolated from this telemetry fix.

---

## 14. 5m INVOCATION VERIFICATION

- `VWAPRules.ts` line 8 strictly declares `supportedTimeframes: ['15m', '1h', '4h']`.
- `StrategyOrchestrator.ts` line 130 iterates strictly over `strategy.manifest.supportedTimeframes`.
- **Production orchestration never invokes VWAP on 5m.**
- 5m remains unsupported; line 57's fail-closed guard correctly returns `0`.

---

## 15. EXACT CONFIDENCE FALLBACK VERIFICATION

In `VWAPStrategy.ts` lines 74–84:
```typescript
const currentCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {
  [targetTimeframe]: closedCandles,
};
```
Because only `targetTimeframe` is supplied in the projection, `ConfidenceEngine.evaluate()` iterates over exactly that single timeframe.
Therefore:
1. `confidenceScore.timeframes[targetTimeframe]` is guaranteed to exist whenever indicators succeed.
2. `confidenceScore.overallScore` is mathematically identical to `timeframes[targetTimeframe].score`.
3. The fallback `tfConf?.score ?? confidenceScore?.overallScore ?? 0` is completely safe and mirrors the exact pattern already present at line 267 of `VWAPStrategy.ts`.
4. If `confidenceScore` is undefined (early fail-closed callsites), the fallback immediately and safely returns `0`.

---

## 16. STRENGTHENED EXACT-SCORE TEST PLAN

The test plan requires **exact target-timeframe score matching**, not merely `toBeGreaterThan(0)`:

### Test 1 — No Crossover (Exact Score Match)
- Fixture with valid 15m candles oscillating above VWAP without crossing.
- Deterministic expected confidence calculated independently from fixture indicator values.
- Assert:
  ```typescript
  expect(result.hasSignal).toBe(false);
  expect(result.confidenceScore).toBe(expectedScore);
  expect(result.confidenceScore).toBe(result.metadata.confidenceScore.timeframes['15m'].score);
  expect(result.metadata.signal).toBeNull();
  ```

### Test 2 — Sideways Chop (Exact Score Match)
- Displacement < 0.2%.
- Assert `result.hasSignal === false`.
- Assert `result.confidenceScore === expectedScore`.
- Assert `result.metadata.reasoning`.toContain('No meaningful VWAP displacement');

### Test 3 — Low Volume (Exact Score Match)
- Valid crossover but volume < 1.5x average.
- Assert `result.hasSignal === false`.
- Assert `result.confidenceScore === expectedScore`.
- Assert `result.metadata.reasoning`.toContain('Low volume rejection');

### Test 4 — Overextended Price (Exact Score Match)
- Distance from VWAP > 3.0%.
- Assert `result.hasSignal === false`.
- Assert `result.confidenceScore === expectedScore`.
- Assert `result.metadata.reasoning`.toContain('Price excessively extended');

### Test 5 — Missing Candles (Fail-Closed Zero)
- Empty candle array.
- Assert `result.hasSignal === false`.
- Assert `result.confidenceScore === 0`.

### Test 6 — Unsupported 5m (Fail-Closed Zero)
- Invoke `strategy.evaluate(context, '5m')`.
- Assert `result.hasSignal === false`.
- Assert `result.confidenceScore === 0`.
- Assert `result.metadata.reasoning`.toContain('Unsupported timeframe 5m for VWAP');

### Test 7 — Valid BUY Regression
- Confirm qualified BUY crossover + Model C pass produces `hasSignal: true`, `signal.type === 'BUY'`, directional `longScore >= 70`, correct entry, SL, TP.

### Test 8 — Valid SELL Regression
- Confirm qualified SELL breakdown + Model C pass produces `hasSignal: true`, `signal.type === 'SELL'`, directional `shortScore >= 70`, correct entry, SL, TP.

---

## 17. NO-REGRESSION MATRIX

| Area | Before Fix | After Fix | Must Remain Identical? |
| :--- | :--- | :--- | :--- |
| VWAP supported timeframes | `['15m', '1h', '4h']` | `['15m', '1h', '4h']` | **YES** |
| 5m VWAP fail-closed rejection | Returns no-signal + 0 | Returns no-signal + 0 | **YES** |
| Valid BUY signal qualification | Crossover + Model C required | Crossover + Model C required | **YES** |
| Valid SELL signal qualification | Crossover + Model C required | Crossover + Model C required | **YES** |
| Model C directional arbitration | Unchanged | Unchanged | **YES** |
| ATR risk calculation | Unchanged | Unchanged | **YES** |
| Stop Loss & Take Profit formulas | Unchanged | Unchanged | **YES** |
| `hasSignal` on no-signal bars | `false` | `false` | **YES** |
| `metadata.signal` on no-signal bars | `null` | `null` | **YES** |
| No-signal confidenceScore | `0` (Hardcoded zero) | `primaryTfConfidence.score` | **INTENDED CHANGE** |
| TradeAlert creation | Only on `hasSignal === true` | Only on `hasSignal === true` | **YES** |
| WAL intent persistence | Only on approved alert | Only on approved alert | **YES** |
| Bybit order submission | Only on approved alert | Only on approved alert | **YES** |
| Android score rendering | Renders supplied score | Renders supplied score | **YES** |
| Preview endpoint scope | Unchanged | Unchanged | **YES** |

---

## 18. FILE IMPACT MATRIX

| File | Classification | Proposed Change | Reason | Risk |
| :--- | :--- | :--- | :--- | :--- |
| `backend/src/engine/strategies/vwap/VWAPStrategy.ts` | **MUST CHANGE** | Update `createNoSignalResult()` signature & callsites to preserve `confidenceScore` | Eliminate DEFECT-VWAP-01; preserve indicator score on no-signal bars | **LOW** |
| `backend/src/engine/strategies/vwap/VWAPStrategy.test.ts` | **MAY CHANGE** (Tests) | Add unit tests asserting exact score preservation on no-signal bars | Prevent regressions | **ZERO** |
| `backend/src/engine/orchestrator/StrategyOrchestrator.ts` | **MUST NOT CHANGE** | None | Execution audit proved orchestrator safely isolates non-signals | N/A |
| `backend/src/trading-bot.ts` | **MUST NOT CHANGE** | None | Execution audit proved line 2865 safely isolates non-signals | N/A |
| `backend/src/handlers/exchange.ts` | **MUST NOT CHANGE** | None | Preview endpoint scope remains separate | N/A |
| `mobile/app/src/main/java/com/cryptopulse/app/ui/screens/TechnicalAnalysisScreen.kt` | **MUST NOT CHANGE** | None | Android UI already correctly consumes the backend score contract | N/A |

---

## 19. RISK CLASSIFICATION

- **Risk Level:** **LOW**
- **Justification:**  
  1. The downstream execution-safety audit conclusively proved that non-signal results (`hasSignal: false`) are filtered at line 2865 of `trading-bot.ts` before reaching any alert generation, ranking, coalescing, WAL, or Bybit execution code.
  2. The fix is strictly contained to `VWAPStrategy.ts` and changes only telemetry output on bars where `hasSignal: false`.
  3. Signal qualification, Model C gates, risk parameters, and order dispatch remain 100% untouched.

---

## 20. EXPLICIT ANSWERS Q1–Q10

### Q1: Is DEFECT-VWAP-01 definitely a real defect?
**YES.** Hardcoding `confidenceScore: 0` in `createNoSignalResult` discards valid multi-factor indicator data calculated by `ConfidenceEngine` and violates the standard strategy-result contract followed by ScalperV2, Momentum, Breakout, and MeanReversion.

### Q2: What is the correct semantic meaning of `confidenceScore`?
It represents the health and setup proximity of the target timeframe's technical indicators (0–100). When `hasSignal: true`, it represents directional entry confidence; when `hasSignal: false`, it represents underlying analytical confidence.

### Q3: Should no-signal VWAP evaluations preserve calculated confidence?
**YES.** Whenever valid candle data exists and indicators are successfully calculated, `VWAPStrategy` should output `primaryTfConfidence.score`, exactly as the other four strategies do.

### Q4: Does the Android UI already correctly render a non-zero VWAP confidence?
**YES.** `StrategyScoreCard` already renders `"$score / 100"` with a cyan bar whenever a non-zero integer is received.

### Q5: Is an Android code change actually required?
**NO.** Supplying the non-zero confidence from the backend immediately resolves the display in `StrategyScoreCard` and unfreezes the preview `MarketConditionCard`.

### Q6: Is DEFECT-VWAP-03 independently a real defect?
**NO.** The absence of `strategyAnalyses` in `handleGetTechnicalAnalysis` is a preview endpoint scope boundary affecting all 5 strategies equally. It is not VWAP-specific and does not affect active bot execution.

### Q7: Does the production orchestrator ever invoke VWAP at 5m?
**NO.** Production orchestration iterates strictly over `strategy.manifest.supportedTimeframes` (`15m`, `1h`, `4h`).

### Q8: What is the absolute minimum set of files that should change?
Exactly **one production file**: `backend/src/engine/strategies/vwap/VWAPStrategy.ts` (plus its unit test file `VWAPStrategy.test.ts`).

### Q9: What files must explicitly NOT be changed?
All Android source files (`TechnicalAnalysisScreen.kt`, `BotMapper.kt`, etc.), `StrategyOrchestrator.ts`, `trading-bot.ts`, `VWAPRules.ts`, `VWAPConfig.ts`, `exchange.ts`, and all execution/risk gate files.

### Q10: Does the proposed fix alter live trade qualification or execution behavior?
**NO.** The downstream execution audit proved that line 2865 of `trading-bot.ts` filters out all `hasSignal === false` results. TradeAlert creation, ranking, coalescing, WAL, and Bybit execution remain 100% unaffected.

---

## 21. IMPLEMENTATION-READINESS CHECK

### A. Actual Production ConfidenceScore Type
- **Interface Name:** `ConfidenceScore`
- **Location:** `backend/src/engine/confidence/ConfidenceScore.ts` (lines 14–21)
- **Export Path:** Exported from `backend/src/engine/confidence/index.ts` (line 2)
- **Type Definitions:**
  ```typescript
  export interface ConfidenceScore {
    timestamp: number;
    overallScore: number;
    overallLongScore?: number;
    overallShortScore?: number;
    overallLevel: ConfidenceLevel;
    timeframes: Record<string, TimeframeConfidence>;
  }

  export interface TimeframeConfidence {
    score: number;
    longScore?: number;
    shortScore?: number;
    level: ConfidenceLevel;
    factors: ConfidenceFactors;
    explanation: string[];
  }
  ```
- **Type Safety Finding:** We can import `ConfidenceScore` directly without resorting to `any`.

### B. `createNoSignalResult()` Callsite Audit

| Callsite | Line | Trigger Reason | Confidence Calculated? | Confidence Valid? | Preserve Score? | Expected Return `confidenceScore` |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: |
| 1 | 57 | Unsupported timeframe (e.g. 5m) | NO | NO | NO | `0` (fail-closed) |
| 2 | 62 | Missing candle data | NO | NO | NO | `0` (fail-closed) |
| 3 | 71 | Insufficient candles (<2 closed) | NO | NO | NO | `0` (fail-closed) |
| 4 | 102 | Invalid or zero current price | YES | NO (corrupt data) | NO | `0` (fail-closed) |
| 5 | 107 | Zero or unconfigured balance | YES | NO (unconfigured) | NO | `0` (fail-closed) |
| 6 | 113 | Indicator calculation failure on target TF | YES | NO (TF calc failed)| NO | `0` (fail-closed) |
| 7 | 124 | Price overextended away from VWAP (>3%) | YES | **YES** | **YES** | `primaryTfConfidence.score` |
| 8 | 130 | Sideways chop market (<0.2% displacement) | YES | **YES** | **YES** | `primaryTfConfidence.score` |
| 9 | 142 | Low volume rejection (<1.5x average) | YES | **YES** | **YES** | `primaryTfConfidence.score` |
| 10 | 184 | No definitive VWAP crossover | YES | **YES** | **YES** | `primaryTfConfidence.score` |

### C. Fallback Verification
The fallback `tfConf?.score ?? confidenceScore?.overallScore ?? 0` is confirmed 100% mathematically consistent with the existing pattern at line 267 of `VWAPStrategy.ts`.

### D. Exact Behavioral Contract Across All Paths

| Path | Trigger Condition | `hasSignal` | `confidenceScore` Expected |
| :--- | :--- | :---: | :--- |
| **Unsupported timeframe** | `!manifest.supportedTimeframes.includes(tf)` | `false` | `0` (fail-closed) |
| **Missing candles** | `candles[tf].length === 0` | `false` | `0` (fail-closed) |
| **Insufficient candles** | `closedCandles.length < 2` | `false` | `0` (fail-closed) |
| **Invalid price** | `currentPrice <= 0` | `false` | `0` (fail-closed) |
| **Zero balance** | `accountBalance <= 0` | `false` | `0` (fail-closed) |
| **Indicator failure** | `!tfIndicators` | `false` | `0` (fail-closed) |
| **Price overextended** | `deviation > 3.0%` | `false` | `primaryTfConfidence.score` (50–85) |
| **Sideways market** | `displacement < 0.2%` | `false` | `primaryTfConfidence.score` (50–85) |
| **Low volume** | `volume < 1.5x avg` | `false` | `primaryTfConfidence.score` (50–85) |
| **No crossover** | No cross above/below VWAP | `false` | `primaryTfConfidence.score` (50–85) |
| **Model C rejection** | Crossover occurred, but Model C rejected | `false` | `primaryTfConfidence.score` (50–85) |
| **Valid BUY** | Bullish crossover + Model C BUY pass | `true` | Directional `longScore` (>= 70) |
| **Valid SELL** | Bearish crossover + Model C SELL pass | `true` | Directional `shortScore` (>= 70) |

---

## 22. FINAL VERDICT

```text
================================================================================
FINAL VERDICT: PLAN-A — ISOLATED FIX READY FOR IMPLEMENTATION REVIEW
================================================================================
1. The defect is forensically confirmed and isolated.
2. The downstream execution audit conclusively proved that non-signal results
   with preserved confidence scores are mathematically filtered out at
   line 2865 of trading-bot.ts and can NEVER trigger an alert, participate
   in candidate ranking, create a WAL intent, or reach Bybit execution.
3. The fix is 100% type-safe, requires zero Android changes, touches only one
   production file (VWAPStrategy.ts), and leaves all execution logic untouched.

STATUS: READ-ONLY AUDIT COMPLETE — IMPLEMENTATION NOT AUTHORIZED
================================================================================
```

---

FINAL STATUS: AWAITING USER REVIEW AND EXPLICIT IMPLEMENTATION APPROVAL
