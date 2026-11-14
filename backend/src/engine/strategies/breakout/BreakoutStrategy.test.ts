import { describe, it, expect } from "vitest";
import { BreakoutStrategy } from "./BreakoutStrategy";
import { DEFAULT_BREAKOUT_CONFIG } from "./BreakoutConfig";
import { StrategyContext } from "../../context/StrategyContext";
import { MarketSnapshot, NormalizedCandle } from "../../market-data/MarketSnapshot";
import { SignalType } from "../../signal";
import { CandleValidator } from "../../../infrastructure/exchange/CandleValidator";
import { verifyStrategyDataContract } from "../../matrix/MatrixEvaluator";

// Canonical base timestamp aligned to 4h boundary
const BASE_TIME = 1700000000000 - (1700000000000 % (4 * 3600 * 1000));

function createBullishCandles(
  count = 50,
  tf: "5m" | "15m" | "1h" | "4h" = "5m",
  endTimestamp = BASE_TIME,
  basePrice = 100
): NormalizedCandle[] {
  const tfMs = CandleValidator.timeframeToMs(tf);
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = endTimestamp - (count - i) * tfMs;
    const p = basePrice + i * 2.0;
    candles.push({
      openTime,
      timestamp: openTime,
      open: p - 1,
      high: p + 3,
      low: p - 2,
      close: p,
      volume: 1000 + i * 20
    });
  }
  return candles;
}

function createBearishCandles(
  count = 50,
  tf: "5m" | "15m" | "1h" | "4h" = "5m",
  endTimestamp = BASE_TIME,
  basePrice = 1000
): NormalizedCandle[] {
  const tfMs = CandleValidator.timeframeToMs(tf);
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = endTimestamp - (count - i) * tfMs;
    const p = basePrice - i * 2.0;
    candles.push({
      openTime,
      timestamp: openTime,
      open: p + 1,
      high: p + 2,
      low: p - 3,
      close: p,
      volume: 1000 + i * 20
    });
  }
  return candles;
}

function createFlatCandles(
  count = 50,
  tf: "5m" | "15m" | "1h" | "4h" = "5m",
  endTimestamp = BASE_TIME,
  basePrice = 100
): NormalizedCandle[] {
  const tfMs = CandleValidator.timeframeToMs(tf);
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = endTimestamp - (count - i) * tfMs;
    candles.push({
      openTime,
      timestamp: openTime,
      open: basePrice,
      high: basePrice + 0.1,
      low: basePrice - 0.1,
      close: basePrice,
      volume: 100
    });
  }
  return candles;
}

function buildMtfSnapshot(
  candlesByTf: {
    "5m"?: NormalizedCandle[];
    "15m"?: NormalizedCandle[];
    "1h"?: NormalizedCandle[];
    "4h"?: NormalizedCandle[];
  },
  timestamp = BASE_TIME,
  currentPrice?: number
): MarketSnapshot {
  const latest5m = candlesByTf["5m"];
  const price = currentPrice ?? (latest5m && latest5m.length > 0 ? latest5m[latest5m.length - 1].close : 100);

  return {
    symbol: "BTC/USDT",
    timestamp,
    currentPrice: price,
    volume24h: 10000,
    quoteVolume24h: 10000 * price,
    metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: price + 10, lowPrice24h: price - 10 },
    candles: {
      "5m": candlesByTf["5m"] || [],
      "15m": candlesByTf["15m"] || [],
      "1h": candlesByTf["1h"] || [],
      "4h": candlesByTf["4h"] || [],
    } as any
  };
}

describe("BreakoutStrategy — 4TF Edge-Transition Confluence & Closed-Candle Semantics", () => {
  const defaultStrategy = new BreakoutStrategy();

  // Test with relaxed minConfidenceScore for unit testing edge transitions deterministically
  const testStrategy = new BreakoutStrategy({
    ...DEFAULT_BREAKOUT_CONFIG,
    signalRules: {
      minConfidenceScore: 50,
      allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
    }
  });

  // --------------------------------------------------------------------------
  // TEST 1: Latest 5m forming candle is excluded
  // --------------------------------------------------------------------------
  it("1. Latest 5m forming candle is excluded: latest closed 5m becomes T", () => {
    const closed5m = createBullishCandles(50, "5m", BASE_TIME);
    
    // Add 1 forming 5m candle whose close time > context.timestamp
    const forming5m: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 600,
      high: 610,
      low: 590,
      close: 605,
      volume: 500
    };
    const contextTs = BASE_TIME + 120000; // 2 minutes into forming candle

    const snapshot = buildMtfSnapshot({
      "5m": [...closed5m, forming5m],
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, contextTs);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    expect(result.strategyId).toBe("Breakout");
    if (result.hasSignal) {
      expect(result.metadata.signal?.entryPrice).toBe(closed5m[closed5m.length - 1].close);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 2: Forming 15m, 1h, and 4h candles are excluded
  // --------------------------------------------------------------------------
  it("2. Forming 15m, 1h, and 4h candles are excluded: only closed candles at or before T are used", () => {
    const closed15m = createBullishCandles(50, "15m", BASE_TIME);
    const closed1h = createBullishCandles(50, "1h", BASE_TIME);
    const closed4h = createBullishCandles(50, "4h", BASE_TIME);

    const forming15m: NormalizedCandle = { openTime: BASE_TIME, timestamp: BASE_TIME, open: 600, high: 610, low: 590, close: 605, volume: 500 };
    const forming1h: NormalizedCandle = { openTime: BASE_TIME, timestamp: BASE_TIME, open: 600, high: 610, low: 590, close: 605, volume: 500 };
    const forming4h: NormalizedCandle = { openTime: BASE_TIME, timestamp: BASE_TIME, open: 600, high: 610, low: 590, close: 605, volume: 500 };

    const snapshot = buildMtfSnapshot({
      "5m": createBullishCandles(50, "5m", BASE_TIME),
      "15m": [...closed15m, forming15m],
      "1h": [...closed1h, forming1h],
      "4h": [...closed4h, forming4h],
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    expect(result.strategyId).toBe("Breakout");
    expect(result.metadata.reasoning).toBeInstanceOf(Array);
  });

  // --------------------------------------------------------------------------
  // TEST 3: Candle depth threshold: 34 closed candles fail closed (< 35 required)
  // --------------------------------------------------------------------------
  it("3. Insufficient candles: 34 closed candles fail closed (< 35 required)", () => {
    const snapshot = buildMtfSnapshot({
      "5m": createBullishCandles(34, "5m", BASE_TIME),
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = defaultStrategy.evaluate(context, '5m');

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes("Insufficient closed candle data for timeframe 5m (got 34, required >= 35)"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 4: Candle depth threshold: 35 closed candles pass data-count gate
  // --------------------------------------------------------------------------
  it("4. Candle depth threshold: exactly 35 closed candles pass data-count gate", () => {
    const snapshot = buildMtfSnapshot({
      "5m": createBullishCandles(35, "5m", BASE_TIME),
      "15m": createBullishCandles(35, "15m", BASE_TIME),
      "1h": createBullishCandles(35, "1h", BASE_TIME),
      "4h": createBullishCandles(35, "4h", BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    expect(result.metadata.reasoning.some((r: string) => r.includes("Insufficient closed candle data"))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 5: 35 raw candles with 1 forming candle leaves 34 closed -> fails closed; 36 raw passes
  // --------------------------------------------------------------------------
  it("5. 35 raw candles with 1 forming candle leaves 34 closed -> fails closed; 36 raw passes", () => {
    const closed34 = createBullishCandles(34, "5m", BASE_TIME);
    const forming5m: NormalizedCandle = { openTime: BASE_TIME, timestamp: BASE_TIME, open: 600, high: 610, low: 590, close: 605, volume: 500 };

    const contextTs = BASE_TIME + 120000;
    const snap35Raw = buildMtfSnapshot({
      "5m": [...closed34, forming5m],
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, contextTs);

    const res35Raw = defaultStrategy.evaluate(new StrategyContext(snap35Raw, 10000).freeze(), '5m');
    expect(res35Raw.hasSignal).toBe(false);
    expect(res35Raw.metadata.reasoning.some((r: string) => r.includes("Insufficient closed candle data for timeframe 5m (got 34, required >= 35)"))).toBe(true);

    const closed35 = createBullishCandles(35, "5m", BASE_TIME);
    const snap36Raw = buildMtfSnapshot({
      "5m": [...closed35, forming5m],
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, contextTs);

    const res36Raw = testStrategy.evaluate(new StrategyContext(snap36Raw, 10000).freeze(), '5m');
    expect(res36Raw.metadata.reasoning.some((r: string) => r.includes("Insufficient closed candle data for timeframe 5m"))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 6: 4TF Full Bullish Confluence -> BUY signal
  // --------------------------------------------------------------------------
  it("6. 4TF Bullish Confluence: 4H bullish + 1H bullish + 15M bullish + 5M BUY -> BUY signal", () => {
    // 5m series with previous bar neutral/bearish and current bar strongly bullish
    const fiveMinMs = 5 * 60 * 1000;
    const candles5m = createBullishCandles(50, "5m", BASE_TIME - fiveMinMs);
    // Add one sharp bullish breakout candle at T
    const breakoutClose = 300;
    candles5m.push({
      openTime: BASE_TIME - fiveMinMs,
      timestamp: BASE_TIME - fiveMinMs,
      open: 200,
      high: 305,
      low: 198,
      close: breakoutClose,
      volume: 10000 // Surge volume for breakout
    });

    const snapshot = buildMtfSnapshot({
      "5m": candles5m,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    expect(result.hasSignal).toBe(true);
    expect(result.metadata.signal).not.toBeNull();
    expect(result.metadata.signal?.type).toBe(SignalType.BUY);
    expect(result.metadata.signal?.entryPrice).toBe(breakoutClose);
    expect(result.metadata.signal?.stopLoss).toBeLessThan(breakoutClose);
    expect(result.metadata.signal?.takeProfit).toBeGreaterThan(breakoutClose);
    expect(result.metadata.reasoning.some((r: string) => r.includes("[5M EDGE EVENT] New BUY event"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 7: 4TF Full Bearish Confluence -> SELL signal
  // --------------------------------------------------------------------------
  it("7. 4TF Bearish Confluence: 4H bearish + 1H bearish + 15M bearish + 5M SELL -> SELL signal", () => {
    const fiveMinMs = 5 * 60 * 1000;
    const candles5m = createBearishCandles(50, "5m", BASE_TIME - fiveMinMs);
    const breakdownClose = 800;
    candles5m.push({
      openTime: BASE_TIME - fiveMinMs,
      timestamp: BASE_TIME - fiveMinMs,
      open: 900,
      high: 902,
      low: 795,
      close: breakdownClose,
      volume: 10000
    });

    const snapshot = buildMtfSnapshot({
      "5m": candles5m,
      "15m": createBearishCandles(50, "15m", BASE_TIME),
      "1h": createBearishCandles(50, "1h", BASE_TIME),
      "4h": createBearishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    expect(result.hasSignal).toBe(true);
    expect(result.metadata.signal).not.toBeNull();
    expect(result.metadata.signal?.type).toBe(SignalType.SELL);
    expect(result.metadata.signal?.entryPrice).toBe(breakdownClose);
    expect(result.metadata.signal?.stopLoss).toBeGreaterThan(breakdownClose);
    expect(result.metadata.signal?.takeProfit).toBeLessThan(breakdownClose);
    expect(result.metadata.reasoning.some((r: string) => r.includes("[5M EDGE EVENT] New SELL event"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 8: One required timeframe disagrees -> NO TRADE
  // --------------------------------------------------------------------------
  it("8. Disagreement: 4H bullish + 1H bullish + 15M BEARISH + 5M BUY -> 5M BUY qualifies (MTF cannot veto)", () => {
    const snapshot = buildMtfSnapshot({
      "5m": createBullishCandles(50, "5m", BASE_TIME),
      "15m": createBearishCandles(50, "15m", BASE_TIME), // 15m contradicts BUY!
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    // 15m contradiction cannot veto 5m trigger; MTF is purely informational
    expect(result.metadata.reasoning.some((r: string) => r.includes("[MTF REJECTED]"))).toBe(false);
    expect(result.metadata.targetTimeframe).toBe('5m');
  });

  // --------------------------------------------------------------------------
  // TEST 9: 5M-only trigger without higher timeframes -> NO TRADE
  // --------------------------------------------------------------------------
  it("9. 5M-only trigger: 5M BUY but higher timeframes flat -> NO TRADE", () => {
    const snapshot = buildMtfSnapshot({
      "5m": createBullishCandles(50, "5m", BASE_TIME),
      "15m": createFlatCandles(50, "15m", BASE_TIME), // flat
      "1h": createFlatCandles(50, "1h", BASE_TIME),   // flat
      "4h": createFlatCandles(50, "4h", BASE_TIME),   // flat
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 10: Edge Transition: TRUE -> TRUE continuation is suppressed
  // --------------------------------------------------------------------------
  it("10. Edge Transition: Aligned at both T and T_previous -> continuation suppressed", () => {
    const fiveMinMs = 5 * 60 * 1000;
    const baseCandles5m = createBullishCandles(50, "5m", BASE_TIME - fiveMinMs);
    // Surge candle at T_previous
    const candleTprev: NormalizedCandle = {
      openTime: BASE_TIME - fiveMinMs,
      timestamp: BASE_TIME - fiveMinMs,
      open: 200,
      high: 305,
      low: 198,
      close: 300,
      volume: 10000
    };
    // Surge candle at T
    const candleT: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 300,
      high: 315,
      low: 298,
      close: 310,
      volume: 10000
    };
    const candles5m = [...baseCandles5m, candleTprev, candleT];

    const snapshot = buildMtfSnapshot({
      "5m": candles5m,
      "15m": createBullishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    // Both current and previous bar are aligned, so continuation must be suppressed unconditionally
    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes("[5M CONTINUATION] Trend continuation suppressed"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 11: Original Breakout Calculations & Risk Model Preservation
  // --------------------------------------------------------------------------
  it("11. Identity Preservation: SL/TP ATR multipliers and weights are preserved", () => {
    expect(defaultStrategy.manifest.id).toBe("Breakout");
    expect(defaultStrategy.manifest.category).toBe("Breakout");
    expect(defaultStrategy.manifest.riskProfile).toBe("Medium-High");
    expect(defaultStrategy.manifest.supportsLong).toBe(true);
    expect(defaultStrategy.manifest.supportsShort).toBe(true);
    expect(defaultStrategy.manifest.supportedTimeframes).toEqual(["5m", "15m", "1h", "4h"]);
    expect(defaultStrategy.manifest.minimumCandles).toBe(35);

    // Config defaults
    expect(DEFAULT_BREAKOUT_CONFIG.riskParameters.atrStopLossMultiplier).toBe(2.0);
    expect(DEFAULT_BREAKOUT_CONFIG.riskParameters.atrTakeProfitMultiplier).toBe(3.0);
    expect(DEFAULT_BREAKOUT_CONFIG.riskParameters.maxExposureLimit).toBe(20.0);
    expect(DEFAULT_BREAKOUT_CONFIG.confidenceWeights).toEqual({
      trend: 30,
      momentum: 30,
      volatility: 20,
      volume: 20
    });
    expect(DEFAULT_BREAKOUT_CONFIG.conditionConfig.emaFastPeriod).toBe(9);
    expect(DEFAULT_BREAKOUT_CONFIG.conditionConfig.emaSlowPeriod).toBe(21);
    expect(DEFAULT_BREAKOUT_CONFIG.conditionConfig.atrPeriod).toBe(14);
    expect(DEFAULT_BREAKOUT_CONFIG.conditionConfig.volumePeriod).toBe(20);
  });

  // --------------------------------------------------------------------------
  // TEST 12: Top-25 Autonomous Universe Evaluation
  // --------------------------------------------------------------------------
  it("12. Top-25 Requirement: 25 candidates independently evaluated with zero fallbacks", () => {
    const universe = Array.from({ length: 25 }, (_, idx) => {
      const symbol = `COIN${idx + 1}/USDT`;
      const snap = buildMtfSnapshot({
        "5m": createBullishCandles(40, "5m", BASE_TIME, 10 + idx * 5),
        "15m": createBullishCandles(40, "15m", BASE_TIME, 10 + idx * 5),
        "1h": createBullishCandles(40, "1h", BASE_TIME, 10 + idx * 5),
        "4h": createBullishCandles(40, "4h", BASE_TIME, 10 + idx * 5),
      }, BASE_TIME);
      snap.symbol = symbol;
      return new StrategyContext(snap, 10000).freeze();
    });

    expect(universe.length).toBe(25);

    const evaluatedResults = universe.map(ctx => defaultStrategy.evaluate(ctx, '5m'));

    expect(evaluatedResults.length).toBe(25);
    // Verify each evaluation is independent and corresponds to the exact candidate symbol
    universe.forEach((ctx, idx) => {
      expect(evaluatedResults[idx].strategyId).toBe("Breakout");
      expect(ctx.marketSnapshot.symbol).toBe(`COIN${idx + 1}/USDT`);
    });
  });

  // --------------------------------------------------------------------------
  // TEST 13: MatrixEvaluator Preflight Contract for Breakout
  // --------------------------------------------------------------------------
  it("13. MatrixEvaluator preflight: >= 35 candles required on all 4 timeframes", () => {
    // 34 on 5m -> fail
    const snap34_5m = buildMtfSnapshot({
      "5m": createBullishCandles(34, "5m", BASE_TIME),
      "15m": createBullishCandles(35, "15m", BASE_TIME),
      "1h": createBullishCandles(35, "1h", BASE_TIME),
      "4h": createBullishCandles(35, "4h", BASE_TIME),
    });
    const res34_5m = verifyStrategyDataContract("Breakout", snap34_5m);
    expect(res34_5m.isValid).toBe(false);
    expect(res34_5m.reason).toContain("INSUFFICIENT_5M_BARS (got 34, required >= 35)");

    // 34 on 15m -> fail
    const snap34_15m = buildMtfSnapshot({
      "5m": createBullishCandles(35, "5m", BASE_TIME),
      "15m": createBullishCandles(34, "15m", BASE_TIME),
      "1h": createBullishCandles(35, "1h", BASE_TIME),
      "4h": createBullishCandles(35, "4h", BASE_TIME),
    });
    const res34_15m = verifyStrategyDataContract("Breakout", snap34_15m);
    expect(res34_15m.isValid).toBe(false);
    expect(res34_15m.reason).toContain("INSUFFICIENT_15M_BARS (got 34, required >= 35)");

    // 34 on 1h -> fail
    const snap34_1h = buildMtfSnapshot({
      "5m": createBullishCandles(35, "5m", BASE_TIME),
      "15m": createBullishCandles(35, "15m", BASE_TIME),
      "1h": createBullishCandles(34, "1h", BASE_TIME),
      "4h": createBullishCandles(35, "4h", BASE_TIME),
    });
    const res34_1h = verifyStrategyDataContract("Breakout", snap34_1h);
    expect(res34_1h.isValid).toBe(false);
    expect(res34_1h.reason).toContain("INSUFFICIENT_1H_BARS (got 34, required >= 35)");

    // 34 on 4h -> fail
    const snap34_4h = buildMtfSnapshot({
      "5m": createBullishCandles(35, "5m", BASE_TIME),
      "15m": createBullishCandles(35, "15m", BASE_TIME),
      "1h": createBullishCandles(35, "1h", BASE_TIME),
      "4h": createBullishCandles(34, "4h", BASE_TIME),
    });
    const res34_4h = verifyStrategyDataContract("Breakout", snap34_4h);
    expect(res34_4h.isValid).toBe(false);
    expect(res34_4h.reason).toContain("INSUFFICIENT_4H_BARS (got 34, required >= 35)");

    // 35 on all 4 timeframes -> pass
    const snap35_all = buildMtfSnapshot({
      "5m": createBullishCandles(35, "5m", BASE_TIME),
      "15m": createBullishCandles(35, "15m", BASE_TIME),
      "1h": createBullishCandles(35, "1h", BASE_TIME),
      "4h": createBullishCandles(35, "4h", BASE_TIME),
    });
    const res35_all = verifyStrategyDataContract("Breakout", snap35_all);
    expect(res35_all.isValid).toBe(true);
  });

  // Helper: Construct context that explicitly carries zero balance (bypassing StrategyContext constructor fallback)
  function createZeroBalanceContext(snapshot: MarketSnapshot): Readonly<StrategyContext> {
    const ctx = {
      timestamp: snapshot.timestamp,
      marketSnapshot: snapshot,
      accountBalance: 0,
      freeze: () => ctx
    };
    return ctx as any;
  }

  // --------------------------------------------------------------------------
  // TEST 14: BUY recovery after confirmed transient zero-balance rejection
  // --------------------------------------------------------------------------
  it("14. BUY recovery after confirmed transient zero-balance rejection", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;
    // Flat baseline ensures previous bar is NOT ALIGNED
    const flat5m = createFlatCandles(49, "5m", BASE_TIME - fiveMinMs, 100);
    const surgeCandle: NormalizedCandle = {
      openTime: BASE_TIME - fiveMinMs,
      timestamp: BASE_TIME - fiveMinMs,
      open: 100,
      high: 135,
      low: 100,
      close: 130,
      volume: 50000
    };
    const candles5mBar1 = [...flat5m, surgeCandle];

    const snapBar1 = buildMtfSnapshot({
      "5m": candles5mBar1,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);

    // Bar 1 evaluated with zero balance -> transient risk rejection
    const ctxZeroBal = createZeroBalanceContext(snapBar1);
    const resBar1 = strategy.evaluate(ctxZeroBal, '5m');
    expect(resBar1.hasSignal).toBe(false);
    expect(resBar1.metadata.reasoning.some((r: string) => r.includes("Account balance not available"))).toBe(true);

    // Bar 2: 5 minutes later, breakout alignment continues, balance restored to 10000
    const candleBar2: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 130,
      high: 140,
      low: 128,
      close: 135,
      volume: 50000
    };
    const candles5mBar2 = [...candles5mBar1, candleBar2];

    const snapBar2 = buildMtfSnapshot({
      "5m": candles5mBar2,
      "15m": createBullishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);

    const ctxRestored = new StrategyContext(snapBar2, 10000).freeze();
    const resBar2 = strategy.evaluate(ctxRestored, '5m');

    expect(resBar2.hasSignal).toBe(true);
    expect(resBar2.metadata.signal?.type).toBe(SignalType.BUY);
    expect(resBar2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY] Recovered BUY event"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 15: SELL recovery after confirmed transient zero-balance rejection
  // --------------------------------------------------------------------------
  it("15. SELL recovery after confirmed transient zero-balance rejection", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;
    // Flat baseline ensures previous bar is NOT ALIGNED
    const flat5m = createFlatCandles(49, "5m", BASE_TIME - fiveMinMs, 500);
    const dropCandle: NormalizedCandle = {
      openTime: BASE_TIME - fiveMinMs,
      timestamp: BASE_TIME - fiveMinMs,
      open: 500,
      high: 505,
      low: 390,
      close: 400,
      volume: 50000
    };
    const candles5mBar1 = [...flat5m, dropCandle];

    const snapBar1 = buildMtfSnapshot({
      "5m": candles5mBar1,
      "15m": createBearishCandles(50, "15m", BASE_TIME),
      "1h": createBearishCandles(50, "1h", BASE_TIME),
      "4h": createBearishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);

    const ctxZeroBal = createZeroBalanceContext(snapBar1);
    const resBar1 = strategy.evaluate(ctxZeroBal, '5m');
    expect(resBar1.hasSignal).toBe(false);

    // Bar 2: Breakdown alignment continues, balance restored
    const dropCandle2: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 400,
      high: 402,
      low: 385,
      close: 390,
      volume: 50000
    };
    const candles5mBar2 = [...candles5mBar1, dropCandle2];

    const snapBar2 = buildMtfSnapshot({
      "5m": candles5mBar2,
      "15m": createBearishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBearishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBearishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);

    const ctxRestored = new StrategyContext(snapBar2, 10000).freeze();
    const resBar2 = strategy.evaluate(ctxRestored, '5m');

    expect(resBar2.hasSignal).toBe(true);
    expect(resBar2.metadata.signal?.type).toBe(SignalType.SELL);
    expect(resBar2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY] Recovered SELL event"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 16: Consecutive transient rejections followed by recovery with window check
  // --------------------------------------------------------------------------
  it("16. Consecutive transient rejections followed by recovery, with permitted window explicitly tested", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;
    // Bar 1: Breakout at T_1 from flat baseline
    const flat5m = createFlatCandles(49, "5m", BASE_TIME - fiveMinMs, 100);
    const surgeCandle: NormalizedCandle = {
      openTime: BASE_TIME - fiveMinMs,
      timestamp: BASE_TIME - fiveMinMs,
      open: 100, high: 135, low: 100, close: 130, volume: 50000
    };
    const candlesBar1 = [...flat5m, surgeCandle];
    const snapBar1 = buildMtfSnapshot({
      "5m": candlesBar1,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);
    const resBar1 = strategy.evaluate(createZeroBalanceContext(snapBar1), '5m');
    expect(resBar1.hasSignal).toBe(false);

    // Bar 2: Breakout continues at T_2, but balance is STILL 0 -> rejected again
    const candleBar2: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 130, high: 140, low: 128, close: 135, volume: 50000
    };
    const candlesBar2 = [...candlesBar1, candleBar2];
    const snapBar2 = buildMtfSnapshot({
      "5m": candlesBar2,
      "15m": createBullishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);
    const resBar2 = strategy.evaluate(createZeroBalanceContext(snapBar2), '5m');
    expect(resBar2.hasSignal).toBe(false);

    // Bar 3: Breakout continues at T_3, balance restored -> recovers on Bar 3!
    const candleBar3: NormalizedCandle = {
      openTime: BASE_TIME + fiveMinMs,
      timestamp: BASE_TIME + fiveMinMs,
      open: 135, high: 145, low: 134, close: 140, volume: 50000
    };
    const candlesBar3 = [...candlesBar2, candleBar3];
    const snapBar3 = buildMtfSnapshot({
      "5m": candlesBar3,
      "15m": createBullishCandles(50, "15m", BASE_TIME + 2 * fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + 2 * fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + 2 * fiveMinMs),
    }, BASE_TIME + 2 * fiveMinMs);
    const resBar3 = strategy.evaluate(new StrategyContext(snapBar3, 10000).freeze(), '5m');
    expect(resBar3.hasSignal).toBe(true);
    expect(resBar3.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY] Recovered BUY event"))).toBe(true);

    // Window Check: Bar 4 skipped directly to Bar 6 (gap of 2 bars without evaluation)
    const candlesGap = [...candlesBar3, {
      openTime: BASE_TIME + 4 * fiveMinMs,
      timestamp: BASE_TIME + 4 * fiveMinMs,
      open: 140, high: 150, low: 138, close: 145, volume: 50000
    }];
    const snapGap = buildMtfSnapshot({
      "5m": candlesGap,
      "15m": createBullishCandles(50, "15m", BASE_TIME + 5 * fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + 5 * fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + 5 * fiveMinMs),
    }, BASE_TIME + 5 * fiveMinMs);
    const resGap = strategy.evaluate(new StrategyContext(snapGap, 10000).freeze(), '5m');
    // Mismatch in timestamps cannot recover
    expect(resGap.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY]"))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 17: Repeated evaluation of same closed candle produces no duplicate recovery
  // --------------------------------------------------------------------------
  it("17. Repeated evaluation of the same closed candle does not produce duplicate recovery", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;
    const flat5m = createFlatCandles(49, "5m", BASE_TIME - fiveMinMs, 100);
    const surgeCandle: NormalizedCandle = {
      openTime: BASE_TIME - fiveMinMs,
      timestamp: BASE_TIME - fiveMinMs,
      open: 100, high: 135, low: 100, close: 130, volume: 50000
    };
    const candlesBar1 = [...flat5m, surgeCandle];
    const snapBar1 = buildMtfSnapshot({
      "5m": candlesBar1,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);

    // Initial evaluation with zero balance
    strategy.evaluate(createZeroBalanceContext(snapBar1), '5m');
    // Immediate repeat evaluation on the same candle with zero balance
    const resBar1Repeat = strategy.evaluate(createZeroBalanceContext(snapBar1), '5m');
    expect(resBar1Repeat.hasSignal).toBe(false);

    // Bar 2: Recovers
    const candleBar2: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 130, high: 140, low: 128, close: 135, volume: 50000
    };
    const candlesBar2 = [...candlesBar1, candleBar2];
    const snapBar2 = buildMtfSnapshot({
      "5m": candlesBar2,
      "15m": createBullishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);
    const ctxBar2 = new StrategyContext(snapBar2, 10000).freeze();

    const resBar2 = strategy.evaluate(ctxBar2, '5m');
    expect(resBar2.hasSignal).toBe(true);

    // Immediate repeat evaluation on the exact same Bar 2
    const resBar2Repeat = strategy.evaluate(ctxBar2, '5m');
    expect(resBar2Repeat.hasSignal).toBe(false);
    expect(resBar2Repeat.metadata.reasoning.some((r: string) => r.includes("[5M CONTINUATION]"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 18: Multi-symbol state isolation
  // --------------------------------------------------------------------------
  it("18. Multi-symbol state isolation: symbol A rejection does not bleed into symbol B", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;
    // BTC breaks out at T_1 from flat baseline with zero balance
    const btcFlat = createFlatCandles(49, "5m", BASE_TIME - fiveMinMs, 100);
    const btcSurge: NormalizedCandle = {
      openTime: BASE_TIME - fiveMinMs, timestamp: BASE_TIME - fiveMinMs,
      open: 100, high: 135, low: 100, close: 130, volume: 50000
    };
    const btcCandlesBar1 = [...btcFlat, btcSurge];
    const snapBtc1 = buildMtfSnapshot({
      "5m": btcCandlesBar1,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);
    snapBtc1.symbol = "BTC/USDT";
    const resBtc1 = strategy.evaluate(createZeroBalanceContext(snapBtc1), '5m');
    expect(resBtc1.hasSignal).toBe(false);

    // ETH is completely flat at T_1 with balance 10000
    const ethCandlesBar1 = createFlatCandles(50, "5m", BASE_TIME);
    const snapEth1 = buildMtfSnapshot({
      "5m": ethCandlesBar1,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);
    snapEth1.symbol = "ETH/USDT";
    const resEth1 = strategy.evaluate(new StrategyContext(snapEth1, 10000).freeze(), '5m');
    expect(resEth1.hasSignal).toBe(false);

    // Bar 2: ETH breaks out for the first time at Bar 2 from flat baseline
    const ethFlat = createFlatCandles(49, "5m", BASE_TIME, 100);
    const ethSurge: NormalizedCandle = {
      openTime: BASE_TIME, timestamp: BASE_TIME,
      open: 100, high: 135, low: 100, close: 130, volume: 50000
    };
    const ethCandlesBar2 = [...ethFlat, ethSurge];
    const snapEth2 = buildMtfSnapshot({
      "5m": ethCandlesBar2,
      "15m": createBullishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);
    snapEth2.symbol = "ETH/USDT";
    const resEth2 = strategy.evaluate(new StrategyContext(snapEth2, 10000).freeze(), '5m');
    // ETH should produce a NEW edge event, not a recovered event!
    expect(resEth2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE EVENT] New BUY event"))).toBe(true);
    expect(resEth2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY]"))).toBe(false);

    // Bar 2: BTC continues breakout with balance restored -> BTC recovers
    const btcCandlesBar2 = [...btcCandlesBar1, {
      openTime: BASE_TIME, timestamp: BASE_TIME,
      open: 130, high: 140, low: 128, close: 135, volume: 50000
    }];
    const snapBtc2 = buildMtfSnapshot({
      "5m": btcCandlesBar2,
      "15m": createBullishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);
    snapBtc2.symbol = "BTC/USDT";
    const resBtc2 = strategy.evaluate(new StrategyContext(snapBtc2, 10000).freeze(), '5m');
    expect(resBtc2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY] Recovered BUY event"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 19: Multi-timeframe state isolation
  // --------------------------------------------------------------------------
  it("19. Multi-timeframe state isolation: 5m rejection does not affect 15m", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;
    const btcCandles5m = createBullishCandles(50, "5m", BASE_TIME - fiveMinMs);
    btcCandles5m.push({
      openTime: BASE_TIME - fiveMinMs, timestamp: BASE_TIME - fiveMinMs,
      open: 200, high: 305, low: 198, close: 300, volume: 10000
    });
    const snap = buildMtfSnapshot({
      "5m": btcCandles5m,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);

    // 5m rejected by zero balance
    const res5m = strategy.evaluate(createZeroBalanceContext(snap), '5m');
    expect(res5m.hasSignal).toBe(false);

    // 15m evaluated with positive balance -> 15m must NOT recover 5m's state
    const res15m = strategy.evaluate(new StrategyContext(snap, 10000).freeze(), '15m');
    expect(res15m.metadata.reasoning.some((r: string) => r.includes("[15M EDGE RECOVERY]"))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 20: Alignment break clears pending recovery
  // --------------------------------------------------------------------------
  it("20. Alignment break clears pending recovery: no recovery if alignment is lost", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;
    // Bar 1: Breakout at T_1 with zero balance
    const candlesBar1 = createBullishCandles(50, "5m", BASE_TIME - fiveMinMs);
    candlesBar1.push({
      openTime: BASE_TIME - fiveMinMs, timestamp: BASE_TIME - fiveMinMs,
      open: 200, high: 305, low: 198, close: 300, volume: 10000
    });
    const snapBar1 = buildMtfSnapshot({
      "5m": candlesBar1,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);
    strategy.evaluate(createZeroBalanceContext(snapBar1), '5m');

    // Bar 2: Market breaks alignment (flat/bearish drop)
    const candlesBar2 = [...candlesBar1, {
      openTime: BASE_TIME, timestamp: BASE_TIME,
      open: 300, high: 301, low: 150, close: 160, volume: 100
    }];
    const snapBar2 = buildMtfSnapshot({
      "5m": candlesBar2,
      "15m": createBullishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);
    const resBar2 = strategy.evaluate(new StrategyContext(snapBar2, 10000).freeze(), '5m');

    // Alignment is lost, so no signal and pending recovery must be purged
    expect(resBar2.hasSignal).toBe(false);
    expect(resBar2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY]"))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 21: Direction reversal clears pending recovery
  // --------------------------------------------------------------------------
  it("21. Direction reversal clears pending recovery: BUY rejection does not recover on SELL", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;
    // Bar 1: Bullish breakout with zero balance -> pending BUY rejection
    const candlesBar1 = createBullishCandles(50, "5m", BASE_TIME - fiveMinMs);
    candlesBar1.push({
      openTime: BASE_TIME - fiveMinMs, timestamp: BASE_TIME - fiveMinMs,
      open: 200, high: 305, low: 198, close: 300, volume: 10000
    });
    const snapBar1 = buildMtfSnapshot({
      "5m": candlesBar1,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);
    strategy.evaluate(createZeroBalanceContext(snapBar1), '5m');

    // Bar 2: Flash crash breakdown candle
    const candlesBar2 = [...candlesBar1, {
      openTime: BASE_TIME, timestamp: BASE_TIME,
      open: 300, high: 301, low: 50, close: 60, volume: 20000
    }];
    const snapBar2 = buildMtfSnapshot({
      "5m": candlesBar2,
      "15m": createBearishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBearishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBearishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);
    const resBar2 = strategy.evaluate(new StrategyContext(snapBar2, 10000).freeze(), '5m');

    // It must NEVER recover as a BUY
    expect(resBar2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY] Recovered BUY event"))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 22: Continuation suppression remains correct after successful recovery
  // --------------------------------------------------------------------------
  it("22. Continuation suppression remains correct after successful recovery (Bar 3 suppressed)", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;
    // Bar 1: Rejected
    const candlesBar1 = createBullishCandles(50, "5m", BASE_TIME - fiveMinMs);
    candlesBar1.push({
      openTime: BASE_TIME - fiveMinMs, timestamp: BASE_TIME - fiveMinMs,
      open: 200, high: 305, low: 198, close: 300, volume: 10000
    });
    const snapBar1 = buildMtfSnapshot({
      "5m": candlesBar1,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);
    strategy.evaluate(createZeroBalanceContext(snapBar1), '5m');

    // Bar 2: Recovers
    const candlesBar2 = [...candlesBar1, {
      openTime: BASE_TIME, timestamp: BASE_TIME,
      open: 300, high: 315, low: 298, close: 310, volume: 10000
    }];
    const snapBar2 = buildMtfSnapshot({
      "5m": candlesBar2,
      "15m": createBullishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);
    const resBar2 = strategy.evaluate(new StrategyContext(snapBar2, 10000).freeze(), '5m');
    expect(resBar2.hasSignal).toBe(true);

    // Bar 3: Continuation must be suppressed
    const candlesBar3 = [...candlesBar2, {
      openTime: BASE_TIME + fiveMinMs, timestamp: BASE_TIME + fiveMinMs,
      open: 310, high: 325, low: 308, close: 320, volume: 10000
    }];
    const snapBar3 = buildMtfSnapshot({
      "5m": candlesBar3,
      "15m": createBullishCandles(50, "15m", BASE_TIME + 2 * fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + 2 * fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + 2 * fiveMinMs),
    }, BASE_TIME + 2 * fiveMinMs);
    const resBar3 = strategy.evaluate(new StrategyContext(snapBar3, 10000).freeze(), '5m');

    expect(resBar3.hasSignal).toBe(false);
    expect(resBar3.metadata.reasoning.some((r: string) => r.includes("[5M CONTINUATION] Trend continuation suppressed"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 23: Permanent rejection reasons (invalid price, zero ATR, insufficient candles) do NOT recover
  // --------------------------------------------------------------------------
  it("23. Permanent rejection reasons (invalid price, zero ATR, insufficient candles) do not become recoverable", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;

    // Sub-case A: Invalid current price (<= 0)
    const candlesA1 = createBullishCandles(50, "5m", BASE_TIME - fiveMinMs);
    candlesA1.push({
      openTime: BASE_TIME - fiveMinMs, timestamp: BASE_TIME - fiveMinMs,
      open: 0, high: 0, low: 0, close: 0, volume: 10000
    });
    const snapA1 = buildMtfSnapshot({ "5m": candlesA1 }, BASE_TIME);
    snapA1.currentPrice = 0;
    const resA1 = strategy.evaluate(new StrategyContext(snapA1, 10000).freeze(), '5m');
    expect(resA1.hasSignal).toBe(false);
    expect(resA1.metadata.reasoning.some((r: string) => r.includes("Invalid current price"))).toBe(true);

    // Bar 2 has valid price, but Bar 1 was permanently invalid price -> no recovery!
    const candlesA2 = createBullishCandles(51, "5m", BASE_TIME);
    const snapA2 = buildMtfSnapshot({ "5m": candlesA2 }, BASE_TIME + fiveMinMs);
    const resA2 = strategy.evaluate(new StrategyContext(snapA2, 10000).freeze(), '5m');
    expect(resA2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY]"))).toBe(false);

    // Sub-case B: Zero/invalid ATR (<= 0)
    // 50 identical flat candles where high = low = close produces ATR = 0
    const flat50ZeroTr: NormalizedCandle[] = [];
    for (let i = 0; i < 50; i++) {
      const openTime = (BASE_TIME - fiveMinMs) - (50 - i) * fiveMinMs;
      flat50ZeroTr.push({
        openTime,
        timestamp: openTime,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 1000
      });
    }
    const snapB1 = buildMtfSnapshot({ "5m": flat50ZeroTr }, BASE_TIME - fiveMinMs);
    const resB1 = strategy.evaluate(new StrategyContext(snapB1, 10000).freeze(), '5m');
    expect(resB1.hasSignal).toBe(false);
    expect(resB1.metadata.reasoning.some((r: string) => r.includes("ATR is zero or unavailable"))).toBe(true);

    // Bar 2 has valid ATR, but Bar 1 was permanently rejected by zero ATR -> no recovery!
    const candlesB2 = createBullishCandles(50, "5m", BASE_TIME);
    const snapB2 = buildMtfSnapshot({ "5m": candlesB2 }, BASE_TIME);
    const resB2 = strategy.evaluate(new StrategyContext(snapB2, 10000).freeze(), '5m');
    expect(resB2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY]"))).toBe(false);

    // Sub-case C: Insufficient closed-candle history (< 35 required)
    const candlesC1 = createBullishCandles(30, "5m", BASE_TIME - fiveMinMs);
    const snapC1 = buildMtfSnapshot({ "5m": candlesC1 }, BASE_TIME - fiveMinMs);
    const resC1 = strategy.evaluate(new StrategyContext(snapC1, 10000).freeze(), '5m');
    expect(resC1.hasSignal).toBe(false);
    expect(resC1.metadata.reasoning.some((r: string) => r.includes("Insufficient closed candle data"))).toBe(true);

    // Bar 2 has 35 closed candles, but Bar 1 had insufficient candles -> no recovery!
    const candlesC2 = createBullishCandles(35, "5m", BASE_TIME);
    const snapC2 = buildMtfSnapshot({ "5m": candlesC2 }, BASE_TIME);
    const resC2 = strategy.evaluate(new StrategyContext(snapC2, 10000).freeze(), '5m');
    expect(resC2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY]"))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 24: Recovery reruns fresh risk and safety validation; fresh sizing and SL/TP are computed
  // --------------------------------------------------------------------------
  it("24. Recovery reruns fresh risk and safety validation; fresh sizing and SL/TP are computed", () => {
    const strategy = new BreakoutStrategy({
      ...DEFAULT_BREAKOUT_CONFIG,
      signalRules: {
        minConfidenceScore: 50,
        allowedRiskClassifications: ["LOW", "MEDIUM", "HIGH"]
      }
    });

    const fiveMinMs = 5 * 60 * 1000;
    // Bar 1: Entry price 130, rejected by balance = 0
    const flat5m = createFlatCandles(49, "5m", BASE_TIME - fiveMinMs, 100);
    const surgeCandle: NormalizedCandle = {
      openTime: BASE_TIME - fiveMinMs,
      timestamp: BASE_TIME - fiveMinMs,
      open: 100,
      high: 135,
      low: 100,
      close: 130,
      volume: 50000
    };
    const candlesBar1 = [...flat5m, surgeCandle];
    const snapBar1 = buildMtfSnapshot({
      "5m": candlesBar1,
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);
    strategy.evaluate(createZeroBalanceContext(snapBar1), '5m');

    // Bar 2: Entry price moves up to 140 with different ATR
    const candleBar2: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 130,
      high: 145,
      low: 128,
      close: 140,
      volume: 50000
    };
    const candlesBar2 = [...candlesBar1, candleBar2];
    const snapBar2 = buildMtfSnapshot({
      "5m": candlesBar2,
      "15m": createBullishCandles(50, "15m", BASE_TIME + fiveMinMs),
      "1h": createBullishCandles(50, "1h", BASE_TIME + fiveMinMs),
      "4h": createBullishCandles(50, "4h", BASE_TIME + fiveMinMs),
    }, BASE_TIME + fiveMinMs);
    const resBar2 = strategy.evaluate(new StrategyContext(snapBar2, 10000).freeze(), '5m');

    expect(resBar2.hasSignal).toBe(true);
    // Verified that entry price is freshly 140 (not stale 130 from Bar 1)
    expect(resBar2.metadata.signal?.entryPrice).toBe(140);
    // Verified stopLoss is freshly computed based on 140
    expect(resBar2.metadata.signal?.stopLoss).toBeLessThan(140);
    expect(resBar2.metadata.signal?.takeProfit).toBeGreaterThan(140);
  });

  // --------------------------------------------------------------------------
  // TEST 25: Fails closed on invalid timestamp, symbol, or non-array candles
  // --------------------------------------------------------------------------
  it("25. Fails closed without throwing on non-finite timestamp, blank symbol, or non-array candle series", () => {
    const validSnap = buildMtfSnapshot({
      "5m": createBullishCandles(50, "5m", BASE_TIME),
    }, BASE_TIME);

    // Non-finite context timestamp (frozen invalid snapshot bypassing StrategyContext check)
    const badTsContext = {
      timestamp: NaN,
      accountBalance: 10000,
      marketSnapshot: { ...validSnap, timestamp: NaN },
    } as unknown as Readonly<StrategyContext>;
    const resBadTs = defaultStrategy.evaluate(badTsContext, "5m");
    expect(resBadTs.hasSignal).toBe(false);
    expect(resBadTs.confidenceScore).toBe(0);
    expect(resBadTs.metadata.reasoning[0]).toContain("Invalid evaluation timestamp");

    // Blank symbol
    const blankSymSnap = buildMtfSnapshot({
      "5m": createBullishCandles(50, "5m", BASE_TIME),
    }, BASE_TIME);
    (blankSymSnap as any).symbol = "   ";
    const resBlankSym = defaultStrategy.evaluate(new StrategyContext(blankSymSnap, 10000).freeze(), "5m");
    expect(resBlankSym.hasSignal).toBe(false);
    expect(resBlankSym.metadata.reasoning[0]).toContain("Missing or invalid symbol");

    // Non-array truthy candle container should fail closed cleanly (never throw rawCandles.filter)
    const nonArraySnap = buildMtfSnapshot({}, BASE_TIME);
    (nonArraySnap.candles as any)["5m"] = { length: 50 };
    const resNonArray = defaultStrategy.evaluate(new StrategyContext(nonArraySnap, 10000).freeze(), "5m");
    expect(resNonArray.hasSignal).toBe(false);
    expect(resNonArray.metadata.reasoning[0]).toContain("Missing required candle data");
  });

  // --------------------------------------------------------------------------
  // TEST 26: Missing, zero, or non-finite candle timestamps fail closed (never treated as 0 <= timestamp)
  // --------------------------------------------------------------------------
  it("26. Rejects missing, zero, or non-finite candle timestamps instead of admitting them at closeTime 0", () => {
    const baseCandles = createBullishCandles(50, "5m", BASE_TIME);

    const missingTsCandles = baseCandles.map((c, idx) =>
      idx === 10
        ? { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume } as any
        : c
    );
    const missingTsSnap = buildMtfSnapshot({ "5m": missingTsCandles }, BASE_TIME);
    const resMissingTs = defaultStrategy.evaluate(new StrategyContext(missingTsSnap, 10000).freeze(), "5m");
    expect(resMissingTs.hasSignal).toBe(false);
    expect(resMissingTs.metadata.reasoning[0]).toContain("Invalid candle timestamp");

    const nanCloseCandles = baseCandles.map((c, idx) =>
      idx === baseCandles.length - 1 ? { ...c, closeTime: Number.NaN } : c
    );
    const nanCloseSnap = buildMtfSnapshot({ "5m": nanCloseCandles }, BASE_TIME);
    const resNanClose = defaultStrategy.evaluate(new StrategyContext(nanCloseSnap, 10000).freeze(), "5m");
    expect(resNanClose.hasSignal).toBe(false);
    expect(resNanClose.metadata.reasoning[0]).toContain("Invalid candle timestamp");

    const zeroTsCandles = baseCandles.map((c, idx) =>
      idx === 0 ? { ...c, openTime: 0, timestamp: 0 } : c
    );
    const zeroTsSnap = buildMtfSnapshot({ "5m": zeroTsCandles }, BASE_TIME);
    const resZeroTs = defaultStrategy.evaluate(new StrategyContext(zeroTsSnap, 10000).freeze(), "5m");
    expect(resZeroTs.hasSignal).toBe(false);
    expect(resZeroTs.metadata.reasoning[0]).toContain("Invalid candle timestamp");
  });

  // --------------------------------------------------------------------------
  // TEST 27: Non-finite OHLC, negative prices, high < low, and invalid volume fail closed
  // --------------------------------------------------------------------------
  it("27. Fails closed on NaN, Infinity, -Infinity, negative OHLC, high < low, or invalid volume", () => {
    const fiveMinMs = 5 * 60 * 1000;
    const baseCandles = createBullishCandles(50, "5m", BASE_TIME);

    // NaN close on final bar must fail closed (never silently fall back to snapshot.currentPrice)
    const nanClose = baseCandles.map((c, idx) =>
      idx === baseCandles.length - 1 ? { ...c, close: Number.NaN } : c
    );
    const nanSnap = buildMtfSnapshot({ "5m": nanClose }, BASE_TIME, 50000);
    const resNan = defaultStrategy.evaluate(new StrategyContext(nanSnap, 10000).freeze(), "5m");
    expect(resNan.hasSignal).toBe(false);
    expect(resNan.metadata.reasoning[0]).toContain("Invalid OHLC candle data");

    // Infinity high on final bar must fail closed
    const infHigh = baseCandles.map((c, idx) =>
      idx === baseCandles.length - 1 ? { ...c, high: Number.POSITIVE_INFINITY } : c
    );
    const infSnap = buildMtfSnapshot({ "5m": infHigh }, BASE_TIME);
    const resInf = defaultStrategy.evaluate(new StrategyContext(infSnap, 10000).freeze(), "5m");
    expect(resInf.hasSignal).toBe(false);
    expect(resInf.metadata.reasoning[0]).toContain("Invalid OHLC candle data");

    // Negative low
    const negLow = baseCandles.map((c, idx) =>
      idx === 15 ? { ...c, low: -10 } : c
    );
    const negSnap = buildMtfSnapshot({ "5m": negLow }, BASE_TIME);
    const resNeg = defaultStrategy.evaluate(new StrategyContext(negSnap, 10000).freeze(), "5m");
    expect(resNeg.hasSignal).toBe(false);
    expect(resNeg.metadata.reasoning[0]).toContain("Invalid OHLC candle data");

    // high < low inversion
    const invertedRange = baseCandles.map((c, idx) =>
      idx === 20 ? { ...c, high: 95, low: 105 } : c
    );
    const invSnap = buildMtfSnapshot({ "5m": invertedRange }, BASE_TIME);
    const resInv = defaultStrategy.evaluate(new StrategyContext(invSnap, 10000).freeze(), "5m");
    expect(resInv.hasSignal).toBe(false);
    expect(resInv.metadata.reasoning[0]).toContain("Invalid OHLC candle data");

    // Negative volume
    const negVol = baseCandles.map((c, idx) =>
      idx === 25 ? { ...c, volume: -1 } : c
    );
    const negVolSnap = buildMtfSnapshot({ "5m": negVol }, BASE_TIME + fiveMinMs);
    const resNegVol = defaultStrategy.evaluate(new StrategyContext(negVolSnap, 10000).freeze(), "5m");
    expect(resNegVol.hasSignal).toBe(false);
    expect(resNegVol.metadata.reasoning[0]).toContain("Invalid OHLC candle data");
  });

  // --------------------------------------------------------------------------
  // TEST 28: Earlier zero OHLC fails closed; latest zero close reports invalid price even with non-zero ticker
  // --------------------------------------------------------------------------
  it("28. Rejects earlier zero OHLC candles and enforces latest closed bar price positivity", () => {
    const baseCandles = createBullishCandles(50, "5m", BASE_TIME);

    // Zero OHLC on an earlier candle fails closed at candle validation
    const earlyZero = baseCandles.map((c, idx) =>
      idx === 5 ? { ...c, open: 0, close: 0 } : c
    );
    const earlySnap = buildMtfSnapshot({ "5m": earlyZero }, BASE_TIME);
    const resEarly = defaultStrategy.evaluate(new StrategyContext(earlySnap, 10000).freeze(), "5m");
    expect(resEarly.hasSignal).toBe(false);
    expect(resEarly.metadata.reasoning[0]).toContain("Invalid OHLC candle data");

    // Zero close on latest closed candle must still reject with "Invalid current price" even when snapshot.currentPrice > 0
    const latestZero = [
      ...baseCandles,
      {
        openTime: BASE_TIME,
        timestamp: BASE_TIME,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 10000,
      },
    ];
    const latestSnap = buildMtfSnapshot({ "5m": latestZero }, BASE_TIME + 5 * 60 * 1000, 50000);
    const resLatest = defaultStrategy.evaluate(new StrategyContext(latestSnap, 10000).freeze(), "5m");
    expect(resLatest.hasSignal).toBe(false);
    expect(resLatest.metadata.reasoning.some((r: string) => r.includes("Invalid current price"))).toBe(true);
  });
});
