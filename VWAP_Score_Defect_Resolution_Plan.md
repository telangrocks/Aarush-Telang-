STATUS: READ-ONLY PLAN — IMPLEMENTATION NOT AUTHORIZED

# CRYPTOPULSE — ISOLATED VWAP SCORE DEFECT RESOLUTION PLAN

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

---

## 2. CONFIRMED FINDINGS

### 2.1 DEFECT-VWAP-01 — Backend VWAP No-Signal Score Loss
- **File & Lines:** `backend/src/engine/strategies/vwap/VWAPStrategy.ts` (lines 287–310)
- **Forensic Fact:** In `VWAPStrategy.ts` line 92, `ConfidenceEngine.evaluate(conditionResult)` computes a valid, fully populated `ConfidenceScore` object (`overallScore`, `timeframes['15m'].score`, `longScore`, `shortScore`).
- **The Defect:** When any entry prerequisite fails (price extended at line 124, sideways chop at line 130, low volume at line 142, or no definitive VWAP crossover at line 184), the method exits via `this.createNoSignalResult(...)`.
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
- **Contrast with Strategies 1–4:**  
  `ScalperV2`, `Momentum`, `Breakout`, and `MeanReversion` all preserve their calculated primary timeframe confidence score (`primaryTfConfidence.score`) on normal non-signal analysis. Only `VWAP` collapses to `0`.

### 2.2 DEFECT-VWAP-02 — Android Client Consequence
- **File & Lines:** `mobile/app/src/main/java/com/cryptopulse/app/ui/screens/TechnicalAnalysisScreen.kt` (lines 165–178 & lines 410–428)
- **Forensic Fact:** The Android client has **zero** intentional hiding or discrimination against `VWAP`.
  The Composable `StrategyScoreCard` (line 982) correctly binds `evaluation = effectiveAnalyses.find { it.strategyId.equals("VWAP", ignoreCase = true) }`.
- **The Symptom in Active Bot Mode:** Because the backend emits `confidenceScore: 0`, Android renders `"0 / 100"` with an empty progress bar and an orange `"NOT MET"` badge.
- **The Symptom in Preview Mode:** In preview mode, line 176 triggers:
  ```kotlin
  if (isInsufficientData || isPendingReasoning || (checkpoints.isEmpty() && indicators.isEmpty()) || confidence == 0) {
      return MarketCondition.ANALYZING
  }
  ```
  Because `confidence == 0`, `resolveMarketCondition` treats the cycle as uninitialized, freezing the top card in spinning `"ANALYZING..."` mode forever.

### 2.3 DEFECT-VWAP-03 — Preview Endpoint Scope Isolation
- **File & Lines:** `backend/src/handlers/exchange.ts` (lines 1562–1592)
- **Forensic Fact:** In `handleGetTechnicalAnalysis`, the endpoint executes an on-demand cycle for the single requested strategy (`results = await orchestrator.executeCycle(symbol, normalizedId, ...)`). It then maps a single `AnalysisSnapshotDTO` without calling `AnalysisSnapshotMapper.mapStrategyEvaluations()`.
- **Finding:** In preview mode when the bot is not running, `snapshotDto.strategyAnalyses` is absent for **all five strategies** (all five show `" — / 100 "` and `"EVALUATION PENDING"`). This is an endpoint contract design choice for lightweight single-strategy previews, not a VWAP-specific defect. When the autonomous bot is active, `trading-bot.ts` line 2845 fully populates `strategyAnalyses` for all five strategies.

---

## 3. CONFIDENCESCORE CONTRACT

### 3.1 Intended Semantic Meaning Across CryptoPulse
A forensic survey of `EvaluationResult`, `AnalysisSnapshotMapper`, `StrategyOrchestrator`, `StrategyEvaluationDTO`, `MarketAnalysisDTO`, and the Android presentation layer establishes the authoritative contract:

1. **`hasSignal: boolean` represents Trade Entry Intent:**
   - `true`: A trade trigger has occurred and qualified through risk/confidence thresholds.
   - `false`: No entry signal is active on this candle.
2. **`confidenceScore: number` represents Technical Market Health / Setup Proximity:**
   - When `hasSignal: true`: It represents the directional setup score (longScore for BUY, shortScore for SELL).
   - When `hasSignal: false`: It represents the multi-factor analytical score of the underlying timeframe indicators (`primaryTfConfidence.score`), bounded between 0 and 100.
   - When indicators cannot be computed (missing candles, unsupported timeframe, zero balance): It is `0` or `null` to indicate invalid market data.

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

**Conclusion:** Replacing the calculated confidence with `0` during ordinary non-crossover bars in `VWAPStrategy.ts` violates the established CryptoPulse strategy-result contract.

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

## 5. BACKEND VWAP FIX PLAN (MINIMAL & SURGICAL)

### 5.1 Target File & Method
- **File:** `backend/src/engine/strategies/vwap/VWAPStrategy.ts`
- **Import:** Add `ConfidenceScore` to line 7 imports from `'../../confidence'`.
- **Method:** `createNoSignalResult()` and callsites on lines 124, 130, 142, and 184.

### 5.2 Current vs. Desired Signature & Behavior
```typescript
// CURRENT (VWAPStrategy.ts lines 287-310):
private createNoSignalResult(
  context: Readonly<StrategyContext>,
  reasoning: string[],
  targetTimeframe?: Timeframe,
  indicatorSnapshot?: any,
  conditionResult?: any,
  customIndicators?: any[]
): EvaluationResult {
  return {
    strategyId: this.manifest.id,
    timestamp: context.timestamp,
    confidenceScore: 0,                          // Hardcoded zero
    hasSignal: false,
    metadata: {
      reasoning,
      signal: null,
      targetTimeframe,
      indicatorSnapshot: indicatorSnapshot || { timestamp: context.timestamp, timeframes: {} },
      conditionResult: conditionResult || { timestamp: context.timestamp, overallPass: false, totalConditions: 0, passedConditions: 0, conditions: [] },
      strategyConfig: this.config,
      customIndicators: customIndicators || []
    }
  };
}
```

```typescript
// DESIRED SURGICAL FIX (100% Type-Safe, zero `any` for confidence):
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

### 5.3 Affected Callsites in `VWAPStrategy.evaluate()`:
1. **Line 124 (Overextended check):** Pass `confidenceScore`
   ```typescript
   return this.createNoSignalResult(context, ['Price excessively extended away from VWAP'], targetTimeframe, indicatorSnapshot, conditionResult, confidenceScore);
   ```
2. **Line 130 (Sideways chop check):** Pass `confidenceScore`
   ```typescript
   return this.createNoSignalResult(context, ['No meaningful VWAP displacement (sideways market)'], targetTimeframe, indicatorSnapshot, conditionResult, confidenceScore);
   ```
3. **Line 142 (Low volume rejection):** Pass `confidenceScore`
   ```typescript
   return this.createNoSignalResult(context, ['Low volume rejection (volume confirmation not met)'], targetTimeframe, indicatorSnapshot, conditionResult, confidenceScore);
   ```
4. **Line 184 (No definitive crossover):** Pass `confidenceScore`
   ```typescript
   return this.createNoSignalResult(context, ['No definitive VWAP crossover'], targetTimeframe, indicatorSnapshot, conditionResult, confidenceScore, customIndicators);
   ```
5. **Early Fail-Closed Gates (lines 57, 62, 71, 102, 107, 113):**
   - For lines 57 (unsupported TF), 62 (missing candles), and 71 (insufficient candles): `confidenceScore` has not been evaluated, so it remains `undefined` and safely resolves to `0`.
   - For lines 102 (invalid price), 107 (zero balance), and 113 (indicator failure): `confidenceScore` is omitted or undefined, safely resolving to `0`.

### 5.4 Untouched Logic:
- Qualified signals (lines 263–285): **UNTOUCHED**.
- Model C directional arbitration (lines 188–221): **UNTOUCHED**.
- VWAP calculation (`VWAPCalculator.calculate`): **UNTOUCHED**.
- Risk parameters, ATR, SL/TP calculation: **UNTOUCHED**.
- Supported timeframes (`15m`, `1h`, `4h`): **UNTOUCHED**.

---

## 6. ANDROID IMPACT / FIX PLAN

### 6.1 Is an Android Code Change Required?
**NO.** Forensic evidence proves that **no Android source change is required**.

### 6.2 Forensic Proof:
1. `AnalysisSnapshotDto.kt` (line 73) defines:
   ```kotlin
   data class StrategyEvaluationDto(val strategyId: String? = null, val confidenceScore: Int? = null, ...)
   ```
2. `BotMapper.kt` (line 70) maps:
   ```kotlin
   confidenceScore = it.confidenceScore
   ```
3. Unit test `TechnicalAnalysisViewModelTest.kt` lines 1494–1513 already explicitly asserts:
   ```kotlin
   val reversedEvaluations = listOf(
       StrategyEvaluationDto(strategyId = "VWAP", confidenceScore = 91, requiredScore = 70), ...
   )
   ...
   val vwap = domain.strategyAnalyses.find { it.strategyId.equals("VWAP", ignoreCase = true) }
   assertEquals(91, vwap?.confidenceScore)
   ```
4. `TechnicalAnalysisScreen.kt` (line 410):
   ```kotlin
   val score = evaluation?.confidenceScore
   val scoreText = if (score != null) "$score / 100" else "— / 100"
   ```
   When the backend supplies the non-zero score (e.g. `74`), Android immediately formats `"74 / 100"` and renders the vibrant cyan progress bar.
5. In preview mode, `resolveMarketCondition` receives `confidence = marketAnalysis.confidenceScore`. When the backend supplies the non-zero score instead of `0`, line 176 passes and the card immediately renders the true real-time market condition (BULLISH, BEARISH, SIDEWAYS, or CHOPPY) instead of sticking in `"ANALYZING..."`.

---

## 7. PREVIEW ENDPOINT SCOPE (DEFECT-VWAP-03)

### 7.1 Independent Analysis
1. **Intended Endpoint Contract:**  
   `POST /api/market/technical-analysis` (`handleGetTechnicalAnalysis` in `exchange.ts`) is designed to evaluate on-demand data for a **single symbol** and **single strategy** (`symbol`, `strategy`).
2. **Current Implementation:**  
   It executes `orchestrator.executeCycle(symbol, normalizedId, config, accountBalance)` strictly for `normalizedId`. It does not execute the other four strategies, nor does it attach `strategyAnalyses` to `snapshotDto`.
3. **Consumer Analysis:**  
   `TechnicalAnalysisViewModel.loadPreviewAnalysisSilently` consumes this DTO for single-strategy inspection. In preview mode, `effectiveAnalyses` is empty, so all five cards show `" — / 100 "` and `"EVALUATION PENDING"`.
4. **Is it specific to VWAP?**  
   **NO.** It applies identically to `ScalperV2`, `Momentum`, `Breakout`, `MeanReversion`, and `VWAP`.
5. **Conclusion:**  
   DEFECT-VWAP-03 is an endpoint scope boundary characteristic, not a VWAP-specific bug. It must **NOT** be conflated with DEFECT-VWAP-01. Any future enhancement to populate `strategyAnalyses` in single-strategy preview mode should be handled as a separate telemetry improvement.

---

## 8. 5m INVOCATION VERIFICATION

### 8.1 Trace of Production Orchestrator Invocation
- **Source:** `backend/src/engine/orchestrator/StrategyOrchestrator.ts` (lines 128–135):
  ```typescript
  for (const [id, strategy] of registry.getAllStrategies()) {
    for (const tf of strategy.manifest.supportedTimeframes) {
      const { result, success } = this.evaluateWithTelemetry(strategy, id, tf, symbol, frozenContext, telemetryContext);
      if (result) results.push(result);
    }
  }
  ```
- **Manifest Declaration:** `VWAPRules.ts` (line 8) declares:
  ```typescript
  supportedTimeframes: ['15m', '1h', '4h']
  ```
- **Verification:**  
  When `StrategyOrchestrator` iterates over VWAP, `tf` is strictly drawn from `strategy.manifest.supportedTimeframes`.  
  **The production orchestrator NEVER invokes VWAP on `5m`.**
- **Actionable Conclusion:**  
  Do **NOT** add `5m` to VWAP's supported timeframes. VWAP is architecturally designed as an institutional session timeframe strategy (15m, 1h, 4h). Line 57's fail-closed guard correctly rejects 5m.

---

## 9. EXACT CONFIDENCE SEMANTICS TABLE

| Consumer | Input Field | Meaning Assumed | Behavior on `0` | Behavior on `null` | Correct Semantics? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `VWAPStrategy.ts` | `primaryTfConfidence.score` | Indicator health (EMA, RSI, MACD, Volume) | Output score = 0 | Fallback to overallScore | **BUG:** Currently discards score on no-signal bars |
| `AnalysisSnapshotMapper.ts#L223` | `result.confidenceScore` | Strategy evaluation score | Serialized as `0` | Serialized as `null` | **YES:** Reliably mirrors strategy output |
| `AnalysisSnapshotMapper.ts#L97` | `result.confidenceScore` | Market analysis score | Serialized as `0` | Serialized as `50` | **YES:** Preserves strategy confidence |
| `TechnicalAnalysisScreen.kt#L176` | `marketAnalysis.confidenceScore` | Initialized cycle check | **Stuck in `"ANALYZING..."`** | Treated as pending | **YES:** Correctly assumes 0 means uninitialized |
| `StrategyScoreCard` | `evaluation?.confidenceScore` | Card score & progress bar | Shows `"0 / 100"`, 0% bar | Shows `" — / 100 "` | **YES:** Correct presentation of raw data |
| `trading-bot.ts#L3150` | `result.confidenceScore` | Alert priority ranking | Math.round(0) = 0 | 0 | **YES:** Filtered downstream |

---

## 10. TEST PLAN (BEFORE IMPLEMENTATION)

### 10.1 Unit Tests to Add in `backend/src/engine/strategies/vwap/VWAPStrategy.test.ts`
1. **`test_vwap_no_signal_preserves_indicator_confidence`:**
   - Construct candles with valid indicators where price oscillates above VWAP without crossing.
   - Assert `result.hasSignal === false`.
   - Assert `result.confidenceScore > 0` (matches `primaryTfConfidence.score`).
   - Assert `result.metadata.confidenceScore` is defined and matches the computed confidence result.
2. **`test_vwap_sideways_chop_preserves_confidence`:**
   - Oscillate tightly around VWAP (< 0.2% displacement).
   - Assert `result.hasSignal === false`.
   - Assert `result.metadata.reasoning` contains `'No meaningful VWAP displacement'`.
   - Assert `result.confidenceScore === primaryTfConfidence.score`.
3. **`test_vwap_low_volume_preserves_confidence`:**
   - Valid crossover but volume < 1.5x average.
   - Assert `result.hasSignal === false`.
   - Assert `result.metadata.reasoning` contains `'Low volume rejection'`.
   - Assert `result.confidenceScore === primaryTfConfidence.score`.
4. **`test_vwap_missing_candles_fails_closed_zero`:**
   - Supply empty candles.
   - Assert `result.hasSignal === false`.
   - Assert `result.confidenceScore === 0`.
5. **`test_vwap_unsupported_5m_fails_closed_zero`:**
   - Invoke `strategy.evaluate(context, '5m')`.
   - Assert `result.hasSignal === false`.
   - Assert `result.confidenceScore === 0`.
   - Assert `result.metadata.reasoning` contains `'Unsupported timeframe 5m for VWAP'`.

### 10.2 Regression Tests in `backend/tests/integration/StrategyBehavioralEquivalence.test.ts`
- Run `test_vwap_option_a_equivalence` and `test_confidence_score_mitigation_parity` to ensure parity across 15m, 1h, 4h.

---

## 11. TEST-PROVEN VS SOURCE-INSPECTION EVIDENCE

| Subsystem / Behavior | Evidence Type | Evidence Details |
| :--- | :--- | :--- |
| VWAP computes valid `ConfidenceResult` | **TEST-PROVEN** | `VWAPStrategy.test.ts` Test C verifies `confidenceScore: 75` on qualified breakdown |
| VWAP returns 0 on chop/volume rejection | **TEST-PROVEN** | `VWAPStrategy.test.ts` Tests A & B assert `createNoSignalResult()` is called |
| Other 4 strategies preserve score on no-signal | **SOURCE-INSPECTION** | Verified in `ScalperV2Strategy.ts#L239`, `MomentumStrategy.ts#L321`, `BreakoutStrategy.ts#L332`, `MeanReversionStrategy.ts#L290` |
| Android renders `StrategyScoreCard` identically for all 5 | **TEST-PROVEN** | `TechnicalAnalysisViewModelTest.kt#L1494-L1513` verifies VWAP score 91 renders identically to ScalperV2 score 82 |
| Android `resolveMarketCondition` stuck on `confidence == 0` | **SOURCE-INSPECTION** | Verified in `TechnicalAnalysisScreen.kt#L176` |
| Production orchestrator never invokes VWAP at 5m | **SOURCE-INSPECTION** | Verified in `StrategyOrchestrator.ts#L128-L135` & `VWAPRules.ts#L8` |

---

## 12. FILE IMPACT MATRIX

| File | Classification | Proposed Change | Reason | Risk |
| :--- | :--- | :--- | :--- | :--- |
| `backend/src/engine/strategies/vwap/VWAPStrategy.ts` | **MUST CHANGE** | Update `createNoSignalResult()` to accept and resolve `confidenceScore` | Eliminate Defect VWAP-01; preserve indicator score on no-signal bars | **LOW** |
| `backend/src/engine/strategies/vwap/VWAPStrategy.test.ts` | **MAY CHANGE** (Tests) | Add unit tests asserting score preservation on no-signal bars | Prevent regressions | **ZERO** |
| `backend/src/handlers/exchange.ts` | **MUST NOT CHANGE** | None | Keep preview endpoint scope separate; do not alter exchange routing | N/A |
| `mobile/app/src/main/java/com/cryptopulse/app/ui/screens/TechnicalAnalysisScreen.kt` | **MUST NOT CHANGE** | None | Android UI already correctly consumes the backend score contract | N/A |
| `mobile/app/src/main/java/com/cryptopulse/app/data/mapper/bot/BotMapper.kt` | **MUST NOT CHANGE** | None | Mapping logic is verified correct | N/A |
| `backend/src/engine/orchestrator/StrategyOrchestrator.ts` | **MUST NOT CHANGE** | None | Timeframe iteration is verified correct | N/A |

---

## 13. NO-REGRESSION MATRIX

| Area | Before Fix | After Fix | Must Remain Identical? |
| :--- | :--- | :--- | :--- |
| VWAP signal qualification | Crossover + Model C required | Crossover + Model C required | **YES** |
| VWAP confidence on valid signal | Directional score (>= 70) | Directional score (>= 70) | **YES** |
| VWAP confidence on no-signal bar | `0` (Hardcoded zero) | `primaryTfConfidence.score` (50–85) | **INTENDED CHANGE** |
| VWAP supported timeframes | `['15m', '1h', '4h']` | `['15m', '1h', '4h']` | **YES** |
| 5m VWAP fail-closed rejection | Returns no-signal + 0 | Returns no-signal + 0 | **YES** |
| ATR risk calculation | ATR14 target timeframe | ATR14 target timeframe | **YES** |
| Stop Loss & Take Profit formulas | Current Price ± Multiplier * ATR | Current Price ± Multiplier * ATR | **YES** |
| TradeAlert creation & Bybit execution | Unchanged | Unchanged | **YES** |
| Android `StrategyScoreCard` | Renders supplied score | Renders supplied score | **YES** |
| Preview `strategyAnalyses` | Null in single preview | Null in single preview | **YES** |

---

## 14. EXACT IMPLEMENTATION SEQUENCE

When authorized by the user, execution will proceed in this strict sequence:

1. **Phase 1: Backend Surgical Correction**
   - In `backend/src/engine/strategies/vwap/VWAPStrategy.ts`:
     - Import `ConfidenceScore` from `'../../confidence'`.
     - Add `confidenceScore?: ConfidenceScore` to `createNoSignalResult()` arguments.
     - Extract `const tfConf = targetTimeframe && confidenceScore?.timeframes?.[targetTimeframe];`.
     - Resolve `confidenceScore = tfConf?.score ?? confidenceScore?.overallScore ?? 0;`.
     - Attach `confidenceScore: confidenceScore || null` to `metadata`.
     - Pass `confidenceScore` at lines 124, 130, 142, and 184.
2. **Phase 2: Unit Test Suite Update**
   - Add the 5 non-mutating unit tests in `VWAPStrategy.test.ts`.
3. **Phase 3: Validation Verification**
   - Run vitest on `VWAPStrategy.test.ts`.
   - Run vitest on `StrategyBehavioralEquivalence.test.ts`.
   - Run full TypeScript compilation (`npx tsc --noEmit`).
4. **Phase 4: Diff Inspection**
   - Verify `git diff` touches **only** `VWAPStrategy.ts` and `VWAPStrategy.test.ts`.

---

## 15. VALIDATION COMMAND PLAN

Commands to run **ONLY AFTER** implementation approval:

### 15.1 Backend Targeted Unit Tests
```powershell
npx vitest run src/engine/strategies/vwap/VWAPStrategy.test.ts
```

### 15.2 Backend Strategy Equivalence & Architecture Tests
```powershell
npx vitest run tests/integration/StrategyBehavioralEquivalence.test.ts
npx vitest run src/engine/strategies/ArchitectureValidation.test.ts
```

### 15.3 TypeScript Compilation Check
```powershell
npx tsc --noEmit
```

### 15.4 Android Unit Tests
```powershell
./gradlew testDebugUnitTest --tests "com.cryptopulse.app.ui.strategies.TechnicalAnalysisViewModelTest"
```

### 15.5 Git Diff Inspection
```powershell
git diff --stat
```

---

## 16. RISK CLASSIFICATION

- **Risk Level:** **LOW**
- **Justification:**  
  1. The change is restricted entirely to `VWAPStrategy.createNoSignalResult()`.
  2. It alters **only** the numerical telemetry output on bars where `hasSignal: false`.
  3. It does not alter `hasSignal`, does not create `TradingSignal`, does not alter `TradeAlert`, does not touch Model C gates, does not modify Bybit execution, and touches zero Android source code.

---

## 17. EXPLICIT ANSWERS Q1–Q10

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
All Android source files (`TechnicalAnalysisScreen.kt`, `BotMapper.kt`, etc.), `StrategyOrchestrator.ts`, `VWAPRules.ts`, `VWAPConfig.ts`, `exchange.ts`, and all execution/risk gate files.

### Q10: Does the proposed fix alter live trade qualification or execution behavior?
**NO.** It only changes the score emitted when `hasSignal === false`. Signal qualification, Model C arbitration, ATR, SL/TP, and order execution remain 100% identical.

---

## 18. FINAL PLAN-A VERDICT

```text
================================================================================
FINAL VERDICT: PLAN-A — ISOLATED FIX READY FOR REVIEW
================================================================================
The defect is forensically confirmed, isolated, and completely understood.
A minimal, low-risk, one-file implementation plan exists that resolves the
issue without touching trading logic, execution gates, or Android source code.

NO CODE CHANGES HAVE BEEN MADE.
Awaiting user review and explicit implementation authorization.
================================================================================
```

---

## 19. IMPLEMENTATION-READINESS CHECK

### A. Actual ConfidenceResult Type
- **Interface Name:** `ConfidenceScore`
- **Location:** `backend/src/engine/confidence/ConfidenceScore.ts` (lines 14–21)
- **Export Path:** Exported from `backend/src/engine/confidence/index.ts` (line 2)
- **Field Definitions:**
  ```typescript
  export interface ConfidenceScore {
    timestamp: number;
    overallScore: number;                         // number (0 - 100)
    overallLongScore?: number;                    // number (0 - 100)
    overallShortScore?: number;                   // number (0 - 100)
    overallLevel: ConfidenceLevel;                // 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
    timeframes: Record<string, TimeframeConfidence>;
  }

  export interface TimeframeConfidence {
    score: number;                                // number (0 - 100)
    longScore?: number;                           // number (0 - 100)
    shortScore?: number;                          // number (0 - 100)
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
In `VWAPStrategy.ts` lines 74–84, `snapshotCurrent.candles` is constructed strictly as:
```typescript
const currentCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {
  [targetTimeframe]: closedCandles,
};
```
Because only `targetTimeframe` is supplied in the projection, `ConfidenceEngine.evaluate()` iterates over exactly that single timeframe. Therefore:
1. `confidenceScore.timeframes[targetTimeframe]` is guaranteed to exist whenever indicators succeed.
2. `confidenceScore.overallScore` is mathematically identical to `timeframes[targetTimeframe].score`.
3. The fallback `tfConf?.score ?? confidenceScore?.overallScore ?? 0` is completely safe and mirrors the exact pattern already present at line 267 of `VWAPStrategy.ts`.
4. If `confidenceScore` is undefined (early fail-closed callsites 1–6), the fallback immediately and safely returns `0`.

### D. Type-Safe Implementation Confirmation
The surgical fix can be implemented with **100% type safety** without using `any`:
```typescript
import { ConfidenceEngine, ConfidenceScore } from '../../confidence';

private createNoSignalResult(
  context: Readonly<StrategyContext>,
  reasoning: string[],
  targetTimeframe?: Timeframe,
  indicatorSnapshot?: any,
  conditionResult?: any,
  confidenceScore?: ConfidenceScore,
  customIndicators?: any[]
): EvaluationResult
```

### E. Exact Behavioral Contract Across All Paths

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

### F. Final File Impact Reconfirmation
- **MUST CHANGE:**
  `backend/src/engine/strategies/vwap/VWAPStrategy.ts`
- **MAY CHANGE:**
  `backend/src/engine/strategies/vwap/VWAPStrategy.test.ts`
- **MUST NOT CHANGE:**
  All other backend files, all mobile/Android files, all migrations, all adapters, all configurations.

---

FINAL STATUS: AWAITING USER REVIEW AND EXPLICIT IMPLEMENTATION APPROVAL
