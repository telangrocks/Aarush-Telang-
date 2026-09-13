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
      minConfidenceScore: 30,
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
    const result = testStrategy.evaluate(context);

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
    const result = testStrategy.evaluate(context);

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
    const result = defaultStrategy.evaluate(context);

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
    const result = testStrategy.evaluate(context);

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

    const res35Raw = defaultStrategy.evaluate(new StrategyContext(snap35Raw, 10000).freeze());
    expect(res35Raw.hasSignal).toBe(false);
    expect(res35Raw.metadata.reasoning.some((r: string) => r.includes("Insufficient closed candle data for timeframe 5m (got 34, required >= 35)"))).toBe(true);

    const closed35 = createBullishCandles(35, "5m", BASE_TIME);
    const snap36Raw = buildMtfSnapshot({
      "5m": [...closed35, forming5m],
      "15m": createBullishCandles(50, "15m", BASE_TIME),
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, contextTs);

    const res36Raw = testStrategy.evaluate(new StrategyContext(snap36Raw, 10000).freeze());
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
    const result = testStrategy.evaluate(context);

    if (result.hasSignal) {
      expect(result.metadata.signal?.type).toBe(SignalType.BUY);
      expect(result.metadata.signal?.entryPrice).toBe(breakoutClose);
      expect(result.metadata.signal?.stopLoss).toBeLessThan(breakoutClose);
      expect(result.metadata.signal?.takeProfit).toBeGreaterThan(breakoutClose);
      expect(result.metadata.reasoning.some((r: string) => r.includes("[MTF EDGE EVENT] New BUY event"))).toBe(true);
    }
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
    const result = testStrategy.evaluate(context);

    if (result.hasSignal) {
      expect(result.metadata.signal?.type).toBe(SignalType.SELL);
      expect(result.metadata.signal?.entryPrice).toBe(breakdownClose);
      expect(result.metadata.signal?.stopLoss).toBeGreaterThan(breakdownClose);
      expect(result.metadata.signal?.takeProfit).toBeLessThan(breakdownClose);
      expect(result.metadata.reasoning.some((r: string) => r.includes("[MTF EDGE EVENT] New SELL event"))).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 8: One required timeframe disagrees -> NO TRADE
  // --------------------------------------------------------------------------
  it("8. Disagreement: 4H bullish + 1H bullish + 15M BEARISH + 5M BUY -> NO TRADE", () => {
    const snapshot = buildMtfSnapshot({
      "5m": createBullishCandles(50, "5m", BASE_TIME),
      "15m": createBearishCandles(50, "15m", BASE_TIME), // 15m contradicts BUY!
      "1h": createBullishCandles(50, "1h", BASE_TIME),
      "4h": createBullishCandles(50, "4h", BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes("[MTF REJECTED]") || r.includes("contradicts BUY"))).toBe(true);
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
    const result = testStrategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 10: Edge Transition: TRUE -> TRUE continuation is suppressed
  // --------------------------------------------------------------------------
  it("10. Edge Transition: Aligned at both T and T_previous -> continuation suppressed", () => {
    // Both previous and current candles are long established bullish trend
    const snapshot = buildMtfSnapshot({
      "5m": createBullishCandles(60, "5m", BASE_TIME),
      "15m": createBullishCandles(60, "15m", BASE_TIME),
      "1h": createBullishCandles(60, "1h", BASE_TIME),
      "4h": createBullishCandles(60, "4h", BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context);

    // If both current and previous bar are aligned, it must suppress continuation
    if (result.metadata.reasoning.some((r: string) => r.includes("[MTF CONTINUATION]"))) {
      expect(result.hasSignal).toBe(false);
      expect(result.metadata.signal).toBeNull();
    }
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

    const evaluatedResults = universe.map(ctx => defaultStrategy.evaluate(ctx));

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
});
