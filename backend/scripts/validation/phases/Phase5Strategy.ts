/**
 * Phase 5: Strategy Engine Quality & Determinism (Functional)
 */

import { ValidationPhase, PhaseResult, ValidationLevel } from "../models/ValidationPhase";
import { ValidationContext } from "../models/ValidationContext";
import { StrategyRegistry } from "../../../src/engine/strategies/StrategyRegistry";
import { StrategyContext } from "../../../src/engine/context/StrategyContext";

export class Phase5Strategy implements ValidationPhase {
  public readonly phaseId = 5;
  public readonly phaseName = "Strategy Engine Quality & Determinism";
  public readonly minLevel: ValidationLevel = "level1_public";
  public readonly isDependentGate = false; // Collect all failures

  public async execute(context: ValidationContext): Promise<PhaseResult> {
    const startTime = performance.now();
    const assertions = [];
    let status: "PASS" | "FAIL" = "PASS";

    const registry = StrategyRegistry.getInstance();
    const available = registry.getAvailableStrategies();
    const candles = context.liveCandles.length > 0 ? context.liveCandles : Array.from({ length: 100 }, (_, i) => ({
      openTime: Date.now() - (100 - i) * 900000,
      open: 50000 + i,
      high: 50100 + i,
      low: 49900 + i,
      close: 50050 + i,
      volume: 1000 + i,
      closeTime: Date.now() - (100 - i) * 900000 + 899000,
    }));

    const marketSnapshot: any = {
      timestamp: Date.now(),
      symbol: context.selectedCandidateSymbol,
      exchange: "binance",
      candles: {
        "15m": candles.map(c => ({
          openTime: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          closeTime: c.closeTime || c.openTime + 900000,
        })),
      },
    };
    const stratContext = new StrategyContext(marketSnapshot);

    // 1. All 5 Strategies Executed
    const evalResults: Record<string, any> = {};
    let totalEvalDuration = 0;
    try {
      const eStart = performance.now();
      for (const stratId of available) {
        const strat = registry.getStrategy(stratId);
        if (strat) {
          evalResults[stratId] = strat.evaluate(stratContext);
        }
      }
      totalEvalDuration = performance.now() - eStart;
      const countOk = Object.keys(evalResults).length >= 5;

      assertions.push({
        name: "5-Strategy Suite Execution & Registry Audit",
        passed: countOk,
        details: countOk ? `Evaluated ${Object.keys(evalResults).length} strategies in ${totalEvalDuration.toFixed(2)}ms` : `Found only ${Object.keys(evalResults).length}/5 strategies`,
        empiricalData: { strategies: Object.keys(evalResults), evalDurationMs: totalEvalDuration },
        failureCategory: countOk ? undefined : "APPLICATION_DEFECT",
      });
      if (!countOk) status = "FAIL";
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "5-Strategy Suite Execution & Registry Audit",
        passed: false,
        details: `Strategy evaluation exception: ${e.message}`,
        failureCategory: "APPLICATION_DEFECT",
      });
    }

    // 2. Numerical Sanity (No NaN/Infinity) & Confidence Range [0-100]
    let nanFound = false;
    let confidenceOk = true;
    for (const res of Object.values(evalResults)) {
      if (res) {
        const score = res.confidenceScore;
        if (typeof score !== "number" || isNaN(score) || !isFinite(score)) {
          nanFound = true;
        } else if (score < 0 || score > 100) {
          confidenceOk = false;
        }
      }
    }
    assertions.push({
      name: "Numerical Sanity & Confidence Range [0-100]",
      passed: !nanFound && confidenceOk,
      details: !nanFound && confidenceOk ? "All scores are valid numbers within [0, 100]" : `NaN found=${nanFound}, Invalid bounds=${!confidenceOk}`,
      failureCategory: !nanFound && confidenceOk ? undefined : "APPLICATION_DEFECT",
    });
    if (nanFound || !confidenceOk) status = "FAIL";

    // 3. Strategy Determinism Verification (Identical Inputs = Identical Outputs)
    let deterministic = true;
    try {
      for (const stratId of available) {
        const strat = registry.getStrategy(stratId);
        if (strat) {
          const run1 = strat.evaluate(stratContext);
          const run2 = strat.evaluate(stratContext);
          if (JSON.stringify(run1) !== JSON.stringify(run2)) {
            deterministic = false;
            break;
          }
        }
      }
      assertions.push({
        name: "Strategy Output Determinism Check",
        passed: deterministic,
        details: deterministic ? "100% deterministic output for identical inputs" : "Non-deterministic strategy output detected",
        failureCategory: deterministic ? undefined : "APPLICATION_DEFECT",
      });
      if (!deterministic) status = "FAIL";
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "Strategy Output Determinism Check",
        passed: false,
        details: `Determinism exception: ${e.message}`,
        failureCategory: "APPLICATION_DEFECT",
      });
    }

    return {
      phaseId: this.phaseId,
      phaseName: this.phaseName,
      level: context.level,
      status,
      assertions,
      metrics: {
        durationMs: performance.now() - startTime,
        apiLatencyMs: Math.round(totalEvalDuration),
      },
    };
  }
}
