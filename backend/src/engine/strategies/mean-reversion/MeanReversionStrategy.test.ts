import { describe, it, expect, vi } from "vitest";
import { MeanReversionStrategy } from "./MeanReversionStrategy";
import { DEFAULT_MEAN_REVERSION_CONFIG } from "./MeanReversionConfig";
import { StrategyContext } from "../../context/StrategyContext";
import { MarketSnapshot, NormalizedCandle } from "../../market-data/MarketSnapshot";
import { SignalType } from "../../signal";
import { CandleValidator } from "../../../infrastructure/exchange/CandleValidator";
import { verifyStrategyDataContract } from "../../matrix/MatrixEvaluator";
import { StrategyRegistry } from "../StrategyRegistry";
import { EvaluationResult } from "../../dto/EvaluationResult";
import { TradingBot } from "../../../trading-bot";

// Canonical base timestamp aligned to 4h boundary
const BASE_TIME = 1700000000000 - (1700000000000 % (4 * 3600 * 1000));

function createCandles(
  count = 60,
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
      high: basePrice + 1,
      low: basePrice - 1,
      close: basePrice,
      volume: 1000
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
  currentPrice = 100
): MarketSnapshot {
  return {
    symbol: "BTC/USDT",
    timestamp,
    currentPrice,
    volume24h: 10000,
    quoteVolume24h: 10000 * currentPrice,
    metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: currentPrice + 10, lowPrice24h: currentPrice - 10 },
    candles: {
      "5m": candlesByTf["5m"] || [],
      "15m": candlesByTf["15m"] || [],
      "1h": candlesByTf["1h"] || [],
      "4h": candlesByTf["4h"] || [],
    } as any
  };
}

function createDefaultMtfSnapshot(count = 60, timestamp = BASE_TIME) {
  return buildMtfSnapshot({
    "5m": createCandles(count, "5m", timestamp),
    "15m": createCandles(count, "15m", timestamp),
    "1h": createCandles(count, "1h", timestamp),
    "4h": createCandles(count, "4h", timestamp),
  }, timestamp);
}

function createZeroBalanceContext(snapshot: MarketSnapshot): Readonly<StrategyContext> {
  const ctx = {
    timestamp: snapshot.timestamp,
    marketSnapshot: snapshot,
    accountBalance: 0,
    freeze: () => ctx
  };
  return ctx as any;
}

function mockIndicators(
  strategy: MeanReversionStrategy,
  options: {
    sep4h?: number;
    sep1h?: number;
    sep15m?: number;
    atr15m?: number;
    atr5m?: number;
    currentRsi5m?: number;
    previousRsi5m?: number;
    prevSnapshotRsiCurr?: number;
    prevSnapshotRsiPrev?: number;
    rsiByTimestamp?: Record<number, [number, number]>;
  } = {}
) {
  const {
    sep4h = 1.0,
    sep1h = 1.0,
    sep15m = 1.0,
    atr15m = 2.0,
    atr5m = options.atr5m ?? options.atr15m ?? 2.0,
    currentRsi5m = 28,
    previousRsi5m = 22,
    prevSnapshotRsiCurr = 50,
    prevSnapshotRsiPrev = 50,
    rsiByTimestamp
  } = options;

  vi.spyOn((strategy as any).indicatorEngine, "evaluate").mockImplementation((snapshot: any) => {
    let rsiCurr = currentRsi5m;
    let rsiPrev = previousRsi5m;

    if (rsiByTimestamp && rsiByTimestamp[snapshot.timestamp]) {
      [rsiPrev, rsiCurr] = rsiByTimestamp[snapshot.timestamp];
    } else {
      const isPrev = snapshot.timestamp < BASE_TIME;
      rsiCurr = isPrev ? prevSnapshotRsiCurr : currentRsi5m;
      rsiPrev = isPrev ? prevSnapshotRsiPrev : previousRsi5m;
    }

    return {
      timestamp: snapshot.timestamp,
      timeframes: {
        "4h": {
          close: [100, 100],
          sma: {},
          ema: { 20: [100 * (1 + sep4h / 100)], 50: [100] },
          rsi: { 14: [50, 50] },
          macd: { "12,26,9": [] },
          atr: { 14: [4.0] },
          volume: [1000]
        },
        "1h": {
          close: [100, 100],
          sma: {},
          ema: { 20: [100 * (1 + sep1h / 100)], 50: [100] },
          rsi: { 14: [50, 50] },
          macd: { "12,26,9": [] },
          atr: { 14: [3.0] },
          volume: [1000]
        },
        "15m": {
          close: [100, 100],
          sma: {},
          ema: { 20: [100 * (1 + sep15m / 100)], 50: [100] },
          rsi: { 14: [50, 50] },
          macd: { "12,26,9": [] },
          atr: { 14: [atr15m] },
          volume: [1000]
        },
        "5m": {
          close: [100, 100],
          sma: {},
          ema: { 20: [100], 50: [100] },
          rsi: { 14: [rsiPrev, rsiCurr] },
          macd: { "12,26,9": [] },
          atr: { 14: [atr5m] },
          volume: [1000]
        }
      }
    } as any;
  });
}

describe("MeanReversionStrategy — 4TF MTF Architecture Contract", () => {
  const strategy = new MeanReversionStrategy();

  // ==========================================================================
  // 1. DATA VALIDATION TESTS (Tests 1 - 6)
  // ==========================================================================
  describe("Data Validation", () => {
    it("1. insufficient candles (< 51) -> NO SIGNAL", () => {
      const snap = buildMtfSnapshot({
        "5m": createCandles(50, "5m", BASE_TIME),
        "15m": createCandles(60, "15m", BASE_TIME),
        "1h": createCandles(60, "1h", BASE_TIME),
        "4h": createCandles(60, "4h", BASE_TIME),
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning[0]).toContain("Insufficient closed candle data for timeframe 5m");
    });

    it("2. missing 4H -> opportunistically omitted without failing closed", () => {
      const snap = buildMtfSnapshot({
        "5m": createCandles(60, "5m", BASE_TIME),
        "15m": createCandles(60, "15m", BASE_TIME),
        "1h": createCandles(60, "1h", BASE_TIME),
        "4h": [],
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.metadata.reasoning.some((r: string) => r.includes("Missing required candle data for timeframe 4h"))).toBe(false);
    });

    it("3. missing 1H -> opportunistically omitted without failing closed", () => {
      const snap = buildMtfSnapshot({
        "5m": createCandles(60, "5m", BASE_TIME),
        "15m": createCandles(60, "15m", BASE_TIME),
        "1h": [],
        "4h": createCandles(60, "4h", BASE_TIME),
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.metadata.reasoning.some((r: string) => r.includes("Missing required candle data for timeframe 1h"))).toBe(false);
    });

    it("4. missing 15M -> opportunistically omitted with 5m ATR fallback", () => {
      const snap = buildMtfSnapshot({
        "5m": createCandles(60, "5m", BASE_TIME),
        "15m": [],
        "1h": createCandles(60, "1h", BASE_TIME),
        "4h": createCandles(60, "4h", BASE_TIME),
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.metadata.reasoning.some((r: string) => r.includes("Missing required candle data for timeframe 15m"))).toBe(false);
    });

    it("5. missing 5M -> NO SIGNAL", () => {
      const snap = buildMtfSnapshot({
        "5m": [],
        "15m": createCandles(60, "15m", BASE_TIME),
        "1h": createCandles(60, "1h", BASE_TIME),
        "4h": createCandles(60, "4h", BASE_TIME),
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning[0]).toContain("Missing required candle data for timeframe 5m");
    });

    it("6. forming candle excluded: only closed candles <= context.timestamp participate", () => {
      const closed5m = createCandles(60, "5m", BASE_TIME);
      // Append a forming 5m candle that opens at BASE_TIME and closes in the future
      const forming5m: NormalizedCandle = {
        openTime: BASE_TIME,
        timestamp: BASE_TIME,
        open: 110,
        high: 115,
        low: 108,
        close: 112,
        volume: 200
      };
      const contextTs = BASE_TIME + 60000; // 1 min into forming candle

      const snap = buildMtfSnapshot({
        "5m": [...closed5m, forming5m],
        "15m": createCandles(60, "15m", BASE_TIME),
        "1h": createCandles(60, "1h", BASE_TIME),
        "4h": createCandles(60, "4h", BASE_TIME),
      }, contextTs, 112);

      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.strategyId).toBe("MeanReversion");
      if (res.hasSignal) {
        // Entry price must come from the closed candle (100), not the forming candle (112)
        expect(res.metadata.signal?.entryPrice).toBe(100);
      }
    });
  });

  // ==========================================================================
  // 2. STRUCTURAL FILTERS (Tests 7 - 9)
  // ==========================================================================
  describe("Structural Anti-Runaway Filters", () => {
    it("7. 4H separation > 5% -> 5m oversold curl still emits BUY (informational runaway)", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { sep4h: 5.5, sep1h: 1.0, sep15m: 1.0, currentRsi5m: 28, previousRsi5m: 22 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
      expect(res.metadata.targetTimeframe).toBe('5m');
    });

    it("8. 1H separation > 5% -> 5m oversold curl still emits BUY (informational runaway)", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { sep4h: 1.0, sep1h: 6.2, sep15m: 1.0, currentRsi5m: 28, previousRsi5m: 22 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
      expect(res.metadata.targetTimeframe).toBe('5m');
    });

    it("9. 15M separation > 5% -> 5m oversold curl still emits BUY (informational runaway)", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { sep4h: 1.0, sep1h: 1.0, sep15m: 5.8, currentRsi5m: 28, previousRsi5m: 22 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
      expect(res.metadata.targetTimeframe).toBe('5m');
    });
  });

  // ==========================================================================
  // 3. ENTRY TRIGGER (Tests 10 - 12)
  // ==========================================================================
  describe("Precision Entry Trigger", () => {
    it("10. valid 5M oversold curl -> BUY", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, {
        sep4h: 1.0,
        sep1h: 1.0,
        sep15m: 1.0,
        currentRsi5m: 28,
        previousRsi5m: 22 // <= 25 and curl up > 22
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal).not.toBeNull();
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
    });

    it("11. valid 5M overbought curl -> SELL", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, {
        sep4h: 1.0,
        sep1h: 1.0,
        sep15m: 1.0,
        currentRsi5m: 72,
        previousRsi5m: 78 // >= 75 and curl down < 78
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal).not.toBeNull();
      expect(res.metadata.signal?.type).toBe(SignalType.SELL);
    });

    it("12. RSI does not cross/curl correctly -> NO SIGNAL", () => {
      const snap = createDefaultMtfSnapshot();
      // RSI is oversold at 22, but continues downward to 20 (no curl up)
      mockIndicators(strategy, {
        sep4h: 1.0,
        sep1h: 1.0,
        sep15m: 1.0,
        currentRsi5m: 20,
        previousRsi5m: 22
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning.some((r: string) => r.includes("No valid 5m RSI reversal curl"))).toBe(true);
    });
  });

  // ==========================================================================
  // 4. MEAN REVERSION CONFIDENCE THRESHOLD (Tests 13 - 15c)
  // ==========================================================================
  describe("MeanReversion Confidence Threshold Enforcement (minConfidenceScore: 75)", () => {
    it("13. confidence score below 75 threshold -> rejected (hasSignal: false)", () => {
      const snap = createDefaultMtfSnapshot();
      // Weak/shallow reversal curl: previous RSI 24.5 (barely oversold), current 25.0 (weak 0.5 curl)
      mockIndicators(strategy, { currentRsi5m: 25.0, previousRsi5m: 24.5 });

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.confidenceScore).toBeLessThan(75);
      expect(res.metadata.reasoning.some((r: string) => r.includes("below required minimum (75)"))).toBe(true);
    });

    it("14. decisive reversal curl meeting/exceeding 75 threshold -> accepted (hasSignal: true)", () => {
      const snap = createDefaultMtfSnapshot();
      // Strong reversal curl: previous RSI 22.0 (oversold), current 28.0 (strong 6-point bounce)
      mockIndicators(strategy, { currentRsi5m: 28.0, previousRsi5m: 22.0 });

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal).not.toBeNull();
      expect(res.confidenceScore).toBe(76);
      expect(res.metadata.signal?.confidenceScore).toBe(76);
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
    });

    it("15. SELL reversal confidence enforces 75 threshold symmetrically", () => {
      const snap = createDefaultMtfSnapshot();
      // Strong overbought rejection: previous RSI 78.0, current 72.0 (symmetric 6-point drop, depth 3)
      mockIndicators(strategy, { currentRsi5m: 72.0, previousRsi5m: 78.0 });

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(true);
      expect(res.confidenceScore).toBe(76);
      expect(res.metadata.signal?.type).toBe(SignalType.SELL);
      expect(res.metadata.signal?.confidenceScore).toBe(76);
    });

    it("15b. weak SELL reversal curl below 75 threshold -> rejected", () => {
      const snap = createDefaultMtfSnapshot();
      // Weak overbought curl: previous RSI 75.5, current 75.0 (barely 0.5 drop)
      mockIndicators(strategy, { currentRsi5m: 75.0, previousRsi5m: 75.5 });

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.confidenceScore).toBeLessThan(75);
      expect(res.metadata.reasoning.some((r: string) => r.includes("below required minimum (75)"))).toBe(true);
    });

    it("15c. missing, NaN, or non-finite RSI inputs fail closed with score 0", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { currentRsi5m: NaN, previousRsi5m: 22.0 });

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(false);
      expect(res.confidenceScore).toBe(0);
      expect(res.metadata.signal).toBeNull();
    });

    it("15d. 1.0-point RSI bounce cannot pass the confidence gate (reversal noise rejected)", () => {
      const snap = createDefaultMtfSnapshot();
      // Marginal 1.0-point bounce: previous RSI 24.0, current 25.0
      mockIndicators(strategy, { currentRsi5m: 25.0, previousRsi5m: 24.0 });

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      // Calculated score is ~45, strictly < 75
      expect(res.confidenceScore).toBeLessThan(75);
      expect(res.metadata.reasoning.some((r: string) => r.includes("below required minimum (75)"))).toBe(true);
    });

    it("15e. missing or zero volume receives 0 volume credit and cannot inflate confidence", () => {
      // Build snapshot where candle volume is explicitly 0
      const zeroVolCandles: NormalizedCandle[] = createCandles(60, "5m", BASE_TIME).map(c => ({ ...c, volume: 0 }));
      const snap = buildMtfSnapshot({
        "5m": zeroVolCandles,
        "15m": createCandles(60, "15m", BASE_TIME),
        "1h": createCandles(60, "1h", BASE_TIME),
        "4h": createCandles(60, "4h", BASE_TIME),
      });

      // Moderate curl: previous RSI 23.0, current 26.5 (curl = 3.5).
      // With confirmed volume, this would pass. With 0 volume (0 pts), it fails closed!
      mockIndicators(strategy, { currentRsi5m: 26.5, previousRsi5m: 23.0 });

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.confidenceScore).toBeLessThan(75);
    });

    it("15f. LOW and MEDIUM risk classifications award 0 directional confidence points (independent safety gate)", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { currentRsi5m: 28.0, previousRsi5m: 22.0 });

      // Evaluate under LOW risk
      vi.spyOn((strategy as any).riskEngine, "evaluate").mockReturnValueOnce({
        riskClassification: "LOW",
        stopLossDistance: 2.0,
        takeProfitDistance: 5.0,
        maximumExposure: 10.0,
        positionSizeRecommendation: 10,
        explanation: ["Low risk"]
      } as any);
      const resLow = strategy.evaluate(new StrategyContext(snap, 10000).freeze(), '5m');

      // Evaluate under MEDIUM risk
      vi.spyOn((strategy as any).riskEngine, "evaluate").mockReturnValueOnce({
        riskClassification: "MEDIUM",
        stopLossDistance: 5.0,
        takeProfitDistance: 10.0,
        maximumExposure: 10.0,
        positionSizeRecommendation: 10,
        explanation: ["Medium risk"]
      } as any);
      const resMed = strategy.evaluate(new StrategyContext(snap, 10000).freeze(), '5m');

      expect(resLow.hasSignal).toBe(true);
      expect(resMed.hasSignal).toBe(true);
      // Directional confidence must be identical regardless of risk tier
      expect(resLow.confidenceScore).toBe(resMed.confidenceScore);
      expect(resLow.confidenceScore).toBe(76);
    });

    it("15g. boundary condition: weak curl (2.0 delta) fails (< 75), strong curl (>= 3.5 delta) passes (>= 75)", () => {
      const snap = createDefaultMtfSnapshot();

      // Sub-threshold: previous RSI 23.0, current 25.0 (curl delta = 2.0) -> fails
      mockIndicators(strategy, { currentRsi5m: 25.0, previousRsi5m: 23.0 });
      const resSub = strategy.evaluate(new StrategyContext(snap, 10000).freeze(), '5m');
      expect(resSub.hasSignal).toBe(false);
      expect(resSub.confidenceScore).toBeLessThan(75);

      // Above-threshold: previous RSI 22.0, current 27.0 (curl delta = 5.0) -> qualifies
      mockIndicators(strategy, { currentRsi5m: 27.0, previousRsi5m: 22.0 });
      const resSuper = strategy.evaluate(new StrategyContext(snap, 10000).freeze(), '5m');
      expect(resSuper.hasSignal).toBe(true);
      expect(resSuper.confidenceScore).toBeGreaterThanOrEqual(75);
    });

    it("15h. missing or zero EMA separation fails closed to 0 separation credit", () => {
      const snap = createDefaultMtfSnapshot();
      vi.spyOn((strategy as any).indicatorEngine, "evaluate").mockImplementation((snapshot: any) => ({
        timestamp: snapshot.timestamp,
        timeframes: {
          "5m": { close: [100, 100], sma: {}, ema: { 20: [100], 50: [100] }, rsi: { 14: [23.0, 25.5] }, macd: { "12,26,9": [] }, atr: { 14: [2.0] }, volume: [1000] },
          "15m": { close: [100, 100], sma: {}, ema: { 20: [100], 50: [100] }, rsi: { 14: [50, 50] }, macd: { "12,26,9": [] }, atr: { 14: [2.0] }, volume: [1000] },
          "1h": { close: [100, 100], sma: {}, ema: { 20: [100], 50: [100] }, rsi: { 14: [50, 50] }, macd: { "12,26,9": [] }, atr: { 14: [3.0] }, volume: [1000] },
          "4h": { close: [100, 100], sma: {}, ema: { 20: [100], 50: [100] }, rsi: { 14: [50, 50] }, macd: { "12,26,9": [] }, atr: { 14: [4.0] }, volume: [1000] },
        }
      } as any));

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      // With 0 separation credit, moderate curl fails closed
      expect(res.hasSignal).toBe(false);
      expect(res.confidenceScore).toBeLessThan(75);
    });

    it("15i. BUY and SELL scoring are mathematically and directionally symmetric", () => {
      const snap = createDefaultMtfSnapshot();

      // Pair 1: Depth 5, Delta 5.0 (Boundary 20 -> 25 vs 80 -> 75)
      mockIndicators(strategy, { currentRsi5m: 25.0, previousRsi5m: 20.0 });
      const resBuy1 = strategy.evaluate(new StrategyContext(snap, 10000).freeze(), '5m');

      mockIndicators(strategy, { currentRsi5m: 75.0, previousRsi5m: 80.0 });
      const resSell1 = strategy.evaluate(new StrategyContext(snap, 10000).freeze(), '5m');

      expect(resBuy1.confidenceScore).toBe(resSell1.confidenceScore);
      expect(resBuy1.confidenceScore).toBe(83);

      // Pair 2: Depth 2, Delta 3.0 (Boundary 23 -> 26 vs 77 -> 74)
      mockIndicators(strategy, { currentRsi5m: 26.0, previousRsi5m: 23.0 });
      const resBuy2 = strategy.evaluate(new StrategyContext(snap, 10000).freeze(), '5m');

      mockIndicators(strategy, { currentRsi5m: 74.0, previousRsi5m: 77.0 });
      const resSell2 = strategy.evaluate(new StrategyContext(snap, 10000).freeze(), '5m');

      expect(resBuy2.confidenceScore).toBe(resSell2.confidenceScore);
    });
  });

  // ==========================================================================
  // 5. EDGE TRANSITION (Tests 16 - 21)
  // ==========================================================================
  describe("Edge Transition & Duplicate Control", () => {
    it("16. first valid BUY -> emitted", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, {
        currentRsi5m: 28,
        previousRsi5m: 22,
        prevSnapshotRsiCurr: 50,
        prevSnapshotRsiPrev: 50 // Previous bar was neutral
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
      expect(res.metadata.reasoning.some((r: string) => r.includes("[5M EDGE EVENT] New BUY event"))).toBe(true);
    });

    it("17. repeated BUY -> suppressed", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, {
        currentRsi5m: 28,
        previousRsi5m: 22,
        prevSnapshotRsiCurr: 28,
        prevSnapshotRsiPrev: 22 // Previous bar was already in valid BUY curl state
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning.some((r: string) => r.includes("[5M CONTINUATION] Trend continuation suppressed"))).toBe(true);
    });

    it("18. first valid SELL -> emitted", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, {
        currentRsi5m: 72,
        previousRsi5m: 78,
        prevSnapshotRsiCurr: 50,
        prevSnapshotRsiPrev: 50 // Previous bar neutral
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.SELL);
      expect(res.metadata.reasoning.some((r: string) => r.includes("[5M EDGE EVENT] New SELL event"))).toBe(true);
    });

    it("19. repeated SELL -> suppressed", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, {
        currentRsi5m: 72,
        previousRsi5m: 78,
        prevSnapshotRsiCurr: 72,
        prevSnapshotRsiPrev: 78 // Previous bar was already in valid SELL curl state
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning.some((r: string) => r.includes("[5M CONTINUATION] Trend continuation suppressed"))).toBe(true);
    });

    it("20. BUY -> SELL -> new SELL emitted", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, {
        currentRsi5m: 72,
        previousRsi5m: 78,      // Current is valid SELL
        prevSnapshotRsiCurr: 28,
        prevSnapshotRsiPrev: 22  // Previous was valid BUY
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.SELL);
      expect(res.metadata.reasoning.some((r: string) => r.includes("[5M EDGE EVENT] New SELL event"))).toBe(true);
    });

    it("21. SELL -> BUY -> new BUY emitted", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, {
        currentRsi5m: 28,
        previousRsi5m: 22,      // Current is valid BUY
        prevSnapshotRsiCurr: 72,
        prevSnapshotRsiPrev: 78  // Previous was valid SELL
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
      expect(res.metadata.reasoning.some((r: string) => r.includes("[5M EDGE EVENT] New BUY event"))).toBe(true);
    });
  });

  // ==========================================================================
  // 5B. TRANSIENT REJECTION & BOUNDED EDGE RECOVERY (Tests 21b - 21h)
  // ==========================================================================
  describe("Transient Rejection & Bounded Edge Recovery", () => {
    it("21b. BUY recovers on immediately following closed bar after transient zero balance", () => {
      const freshStrategy = new MeanReversionStrategy();
      const tf5mMs = 5 * 60 * 1000;
      const t0 = BASE_TIME - tf5mMs;
      const t1 = BASE_TIME;
      const t2 = BASE_TIME + tf5mMs;

      // Candle T1: valid BUY curl, but rejected due to zero account balance
      const snapT1 = buildMtfSnapshot({
        "5m": createCandles(60, "5m", t1),
        "15m": createCandles(60, "15m", t1),
        "1h": createCandles(60, "1h", t1),
        "4h": createCandles(60, "4h", t1),
      }, t1);
      mockIndicators(freshStrategy, {
        rsiByTimestamp: {
          [t0]: [50, 50],
          [t1]: [22, 28],
          [t2]: [22, 28]
        }
      });
      const ctxT1 = createZeroBalanceContext(snapT1); // 0 balance -> transient rejection
      const resT1 = freshStrategy.evaluate(ctxT1, '5m');
      expect(resT1.hasSignal).toBe(false);
      expect(resT1.metadata.reasoning.some((r: string) => r.includes("Account balance is zero"))).toBe(true);

      // Candle T2: immediately following bar, alignment continues, balance is restored
      const snapT2 = buildMtfSnapshot({
        "5m": createCandles(61, "5m", t2),
        "15m": createCandles(60, "15m", t2),
        "1h": createCandles(60, "1h", t2),
        "4h": createCandles(60, "4h", t2),
      }, t2);
      const ctxT2 = new StrategyContext(snapT2, 10000).freeze(); // Balance restored
      const resT2 = freshStrategy.evaluate(ctxT2, '5m');
      expect(resT2.hasSignal).toBe(true);
      expect(resT2.metadata.signal?.type).toBe(SignalType.BUY);
      expect(resT2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY] Recovered BUY event"))).toBe(true);
    });

    it("21c. SELL recovers on immediately following closed bar after transient disallowed risk tier", () => {
      const freshStrategy = new MeanReversionStrategy();
      const tf5mMs = 5 * 60 * 1000;
      const t0 = BASE_TIME - tf5mMs;
      const t1 = BASE_TIME;
      const t2 = BASE_TIME + tf5mMs;

      // Candle T1: valid SELL curl, but rejected due to HIGH risk tier
      const snapT1 = buildMtfSnapshot({
        "5m": createCandles(60, "5m", t1),
        "15m": createCandles(60, "15m", t1),
        "1h": createCandles(60, "1h", t1),
        "4h": createCandles(60, "4h", t1),
      }, t1);
      mockIndicators(freshStrategy, {
        rsiByTimestamp: {
          [t0]: [50, 50],
          [t1]: [78, 72],
          [t2]: [78, 72]
        }
      });
      vi.spyOn((freshStrategy as any).riskEngine, "evaluate").mockReturnValueOnce({
        riskClassification: "HIGH", // Transiently disallowed
        stopLossDistance: 5.0,
        takeProfitDistance: 10.0,
        maximumExposure: 10.0,
        positionSizeRecommendation: 10,
        leverageRecommendation: 1,
        explanation: ["High risk due to temporary volatility"]
      } as any);

      const ctxT1 = new StrategyContext(snapT1, 10000).freeze();
      const resT1 = freshStrategy.evaluate(ctxT1, '5m');
      expect(resT1.hasSignal).toBe(false);
      expect(resT1.metadata.reasoning.some((r: string) => r.includes("Risk classification HIGH is not allowed"))).toBe(true);

      // Candle T2: immediately following bar, alignment continues, risk tier cools to MEDIUM
      const snapT2 = buildMtfSnapshot({
        "5m": createCandles(61, "5m", t2),
        "15m": createCandles(60, "15m", t2),
        "1h": createCandles(60, "1h", t2),
        "4h": createCandles(60, "4h", t2),
      }, t2);
      vi.spyOn((freshStrategy as any).riskEngine, "evaluate").mockReturnValueOnce({
        riskClassification: "MEDIUM", // Restored to allowed
        stopLossDistance: 5.0,
        takeProfitDistance: 10.0,
        maximumExposure: 10.0,
        positionSizeRecommendation: 10,
        leverageRecommendation: 1,
        explanation: ["Medium risk"]
      } as any);

      const ctxT2 = new StrategyContext(snapT2, 10000).freeze();
      const resT2 = freshStrategy.evaluate(ctxT2, '5m');
      expect(resT2.hasSignal).toBe(true);
      expect(resT2.metadata.signal?.type).toBe(SignalType.SELL);
      expect(resT2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE RECOVERY] Recovered SELL event"))).toBe(true);
    });

    it("21d. recovery expires after one bar (cannot recover on T + 2*tfMs)", () => {
      const freshStrategy = new MeanReversionStrategy();
      const tf5mMs = 5 * 60 * 1000;
      const t0 = BASE_TIME - tf5mMs;
      const t1 = BASE_TIME;
      const t2 = BASE_TIME + tf5mMs;
      const t3 = BASE_TIME + 2 * tf5mMs;

      // Bar T1: rejected due to zero balance
      const snapT1 = createDefaultMtfSnapshot(60, t1);
      mockIndicators(freshStrategy, {
        rsiByTimestamp: {
          [t0]: [50, 50],
          [t1]: [22, 28],
          [t2]: [22, 28],
          [t3]: [22, 28]
        }
      });
      const ctxT1 = createZeroBalanceContext(snapT1);
      freshStrategy.evaluate(ctxT1, '5m');

      // Skip T2, evaluate at T3: pending recovery timestamp is T1, but T_prev at T3 is T2
      const snapT3 = createDefaultMtfSnapshot(62, t3);
      const ctxT3 = new StrategyContext(snapT3, 10000).freeze();
      const resT3 = freshStrategy.evaluate(ctxT3, '5m');

      expect(resT3.hasSignal).toBe(false);
      expect(resT3.metadata.reasoning.some((r: string) => r.includes("Trend continuation suppressed"))).toBe(true);
    });

    it("21e. recovery cleared if market alignment breaks before recovery", () => {
      const freshStrategy = new MeanReversionStrategy();
      const tf5mMs = 5 * 60 * 1000;
      const t0 = BASE_TIME - tf5mMs;
      const t1 = BASE_TIME;
      const t2 = BASE_TIME + tf5mMs;

      // Bar T1: rejected due to zero balance
      const snapT1 = createDefaultMtfSnapshot(60, t1);
      mockIndicators(freshStrategy, {
        rsiByTimestamp: {
          [t0]: [50, 50],
          [t1]: [22, 28],
          [t2]: [50, 50]
        }
      });
      freshStrategy.evaluate(createZeroBalanceContext(snapT1), '5m');

      // Bar T2: RSI returns to neutral 50 (alignment breaks)
      const snapT2 = createDefaultMtfSnapshot(61, t2);
      const resT2 = freshStrategy.evaluate(new StrategyContext(snapT2, 10000).freeze(), '5m');

      expect(resT2.hasSignal).toBe(false);
      expect(resT2.metadata.signal).toBeNull();
    });

    it("21f. recovery cleared if direction reverses before recovery", () => {
      const freshStrategy = new MeanReversionStrategy();
      const tf5mMs = 5 * 60 * 1000;
      const t0 = BASE_TIME - tf5mMs;
      const t1 = BASE_TIME;
      const t2 = BASE_TIME + tf5mMs;

      // Bar T1: BUY rejected due to zero balance
      const snapT1 = createDefaultMtfSnapshot(60, t1);
      mockIndicators(freshStrategy, {
        rsiByTimestamp: {
          [t0]: [50, 50],
          [t1]: [22, 28],
          [t2]: [78, 72]
        }
      });
      freshStrategy.evaluate(createZeroBalanceContext(snapT1), '5m');

      // Bar T2: sudden reversal into valid SELL setup (RSI 72 from 78)
      const snapT2 = createDefaultMtfSnapshot(61, t2);
      const resT2 = freshStrategy.evaluate(new StrategyContext(snapT2, 10000).freeze(), '5m');

      expect(resT2.hasSignal).toBe(true);
      expect(resT2.metadata.signal?.type).toBe(SignalType.SELL);
      expect(resT2.metadata.reasoning.some((r: string) => r.includes("[5M EDGE EVENT] New SELL event"))).toBe(true);
    });

    it("21g. permanent/non-recoverable failure (invalid price/ATR) clears pending recovery", () => {
      const freshStrategy = new MeanReversionStrategy();
      const tf5mMs = 5 * 60 * 1000;
      const t0 = BASE_TIME - tf5mMs;
      const t1 = BASE_TIME;
      const t2 = BASE_TIME + tf5mMs;

      // Bar T1: rejected due to zero balance
      const snapT1 = createDefaultMtfSnapshot(60, t1);
      mockIndicators(freshStrategy, {
        rsiByTimestamp: {
          [t0]: [50, 50],
          [t1]: [22, 28],
          [t2]: [22, 28]
        }
      });
      freshStrategy.evaluate(createZeroBalanceContext(snapT1), '5m');

      // Bar T2: price is invalid (-100) -> clears recovery and fails closed
      const snapT2 = buildMtfSnapshot({
        "5m": createCandles(61, "5m", t2, -100),
      }, t2, -100);
      const resT2 = freshStrategy.evaluate(new StrategyContext(snapT2, 10000).freeze(), '5m');

      expect(resT2.hasSignal).toBe(false);
      expect(resT2.metadata.reasoning.some((r: string) => r.includes("Invalid current price"))).toBe(true);
    });

    it("21h. recovered signal suppresses continuation on subsequent bar (no duplicate signals)", () => {
      const freshStrategy = new MeanReversionStrategy();
      const tf5mMs = 5 * 60 * 1000;
      const t0 = BASE_TIME - tf5mMs;
      const t1 = BASE_TIME;
      const t2 = BASE_TIME + tf5mMs;
      const t3 = BASE_TIME + 2 * tf5mMs;

      // Bar T1: rejected due to zero balance
      const snapT1 = createDefaultMtfSnapshot(60, t1);
      mockIndicators(freshStrategy, {
        rsiByTimestamp: {
          [t0]: [50, 50],
          [t1]: [22, 28],
          [t2]: [22, 28],
          [t3]: [22, 28]
        }
      });
      freshStrategy.evaluate(createZeroBalanceContext(snapT1), '5m');

      // Bar T2: successfully recovered
      const snapT2 = createDefaultMtfSnapshot(61, t2);
      const resT2 = freshStrategy.evaluate(new StrategyContext(snapT2, 10000).freeze(), '5m');
      expect(resT2.hasSignal).toBe(true);

      // Bar T3: continuation is suppressed
      const snapT3 = createDefaultMtfSnapshot(62, t3);
      const resT3 = freshStrategy.evaluate(new StrategyContext(snapT3, 10000).freeze(), '5m');
      expect(resT3.hasSignal).toBe(false);
      expect(resT3.metadata.reasoning.some((r: string) => r.includes("[5M CONTINUATION] Trend continuation suppressed"))).toBe(true);
    });
  });

  // ==========================================================================
  // 6. RISK & SIZING (Tests 22 - 26)
  // ==========================================================================
  describe("Risk & Sizing Anchored to Evaluation Timeframe ATR", () => {
    it("22. target timeframe ATR is used (5m ATR on 5m evaluation, distinct from 15m ATR)", () => {
      const snap = createDefaultMtfSnapshot();
      // Genuinely distinct values: 15m ATR is 4.0, 5m ATR is 1.0
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22, atr5m: 1.0, atr15m: 4.0 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(true);
      // Stop loss distance should be 5m ATR (1.0) * 1.2 = 1.2, NOT 15m ATR (4.0 * 1.2 = 4.8)
      expect(res.metadata.signal?.riskAssessment.stopLossDistance).toBeCloseTo(1.2, 4);
      expect(res.metadata.signal?.riskAssessment.stopLossDistance).not.toBeCloseTo(4.8, 4);
    });

    it("22b. 15m evaluation strictly uses 15m ATR (distinct from 5m ATR)", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22, atr5m: 1.0, atr15m: 4.0 });
      vi.spyOn((strategy as any).indicatorEngine, "evaluate").mockImplementation((snapshot: any) => {
        const isPrev = snapshot.timestamp < BASE_TIME;
        const rsiCurr = isPrev ? 50 : 28;
        const rsiPrev = isPrev ? 50 : 22;
        return {
          timestamp: snapshot.timestamp,
          timeframes: {
            "5m": { close: [100, 100], sma: {}, ema: { 20: [100], 50: [100] }, rsi: { 14: [50, 50] }, macd: { "12,26,9": [] }, atr: { 14: [1.0] }, volume: [1000] },
            "15m": { close: [100, 100], sma: {}, ema: { 20: [100], 50: [100] }, rsi: { 14: [rsiPrev, rsiCurr] }, macd: { "12,26,9": [] }, atr: { 14: [4.0] }, volume: [1000] },
            "1h": { close: [100, 100], sma: {}, ema: { 20: [100], 50: [100] }, rsi: { 14: [50, 50] }, macd: { "12,26,9": [] }, atr: { 14: [3.0] }, volume: [1000] },
            "4h": { close: [100, 100], sma: {}, ema: { 20: [100], 50: [100] }, rsi: { 14: [50, 50] }, macd: { "12,26,9": [] }, atr: { 14: [4.0] }, volume: [1000] },
          }
        } as any;
      });

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '15m');

      expect(res.hasSignal).toBe(true);
      // Stop loss distance on 15m should be 15m ATR (4.0) * 1.2 = 4.8, NOT 5m ATR (1.0 * 1.2 = 1.2)
      expect(res.metadata.signal?.riskAssessment.stopLossDistance).toBeCloseTo(4.8, 4);
      expect(res.metadata.signal?.riskAssessment.stopLossDistance).not.toBeCloseTo(1.2, 4);
    });

    it("23. SL = 1.2x ATR", () => {
      const snap = createDefaultMtfSnapshot(60, BASE_TIME);
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22, atr15m: 5.0 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.riskAssessment.stopLossDistance).toBeCloseTo(6.0, 4); // 5.0 * 1.2
      // For BUY at price 100, SL = 100 - 6.0 = 94
      expect(res.metadata.signal?.stopLoss).toBeCloseTo(94.0, 4);
    });

    it("24. TP = 2.5x ATR", () => {
      const snap = createDefaultMtfSnapshot(60, BASE_TIME);
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22, atr15m: 5.0 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.riskAssessment.takeProfitDistance).toBeCloseTo(12.5, 4); // 5.0 * 2.5
      // For BUY at price 100, TP = 100 + 12.5 = 112.5
      expect(res.metadata.signal?.takeProfit).toBeCloseTo(112.5, 4);
    });

    it("25. exposure <= 10%", () => {
      const snap = createDefaultMtfSnapshot(60, BASE_TIME);
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(true);
      const exposurePercent = (res.metadata.signal?.riskAssessment.maximumExposure! / 10000) * 100;
      expect(exposurePercent).toBeLessThanOrEqual(10.0);
      expect(DEFAULT_MEAN_REVERSION_CONFIG.riskParameters.maxExposureLimit).toBe(10.0);
    });

    it("26. invalid risk classification -> NO SIGNAL", () => {
      const snap = createDefaultMtfSnapshot(60, BASE_TIME);
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22 });

      vi.spyOn((strategy as any).riskEngine, "evaluate").mockReturnValue({
        riskClassification: "HIGH", // Allowed is LOW, MEDIUM
        stopLossDistance: 5.0,
        takeProfitDistance: 10.0,
        maximumExposure: 10.0,
        positionSizeRecommendation: 10,
        leverageRecommendation: 1,
        explanation: ["High risk due to high volatility"]
      } as any);

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx, '5m');

      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning.some((r: string) => r.includes("Risk classification HIGH is not allowed"))).toBe(true);
    });
  });

  // ==========================================================================
  // 7. REGRESSION & PREFLIGHT VERIFICATION (Tests 27 - 28)
  // ==========================================================================
  describe("Regression & Preflight Contract", () => {
    it("27. MatrixEvaluator verifyStrategyDataContract enforces >= 51 closed candles across all 4 timeframes", () => {
      // 50 on 5m -> fail
      const snap50_5m = buildMtfSnapshot({
        "5m": createCandles(50, "5m", BASE_TIME),
        "15m": createCandles(51, "15m", BASE_TIME),
        "1h": createCandles(51, "1h", BASE_TIME),
        "4h": createCandles(51, "4h", BASE_TIME),
      });
      const res50_5m = verifyStrategyDataContract("MeanReversion", snap50_5m);
      expect(res50_5m.isValid).toBe(false);
      expect(res50_5m.reason).toContain("INSUFFICIENT_5M_BARS (got 50, required >= 51)");

      // 50 on 15m -> fail
      const snap50_15m = buildMtfSnapshot({
        "5m": createCandles(51, "5m", BASE_TIME),
        "15m": createCandles(50, "15m", BASE_TIME),
        "1h": createCandles(51, "1h", BASE_TIME),
        "4h": createCandles(51, "4h", BASE_TIME),
      });
      const res50_15m = verifyStrategyDataContract("MeanReversion", snap50_15m);
      expect(res50_15m.isValid).toBe(false);
      expect(res50_15m.reason).toContain("INSUFFICIENT_15M_BARS (got 50, required >= 51)");

      // 50 on 1h -> fail
      const snap50_1h = buildMtfSnapshot({
        "5m": createCandles(51, "5m", BASE_TIME),
        "15m": createCandles(51, "15m", BASE_TIME),
        "1h": createCandles(50, "1h", BASE_TIME),
        "4h": createCandles(51, "4h", BASE_TIME),
      });
      const res50_1h = verifyStrategyDataContract("MeanReversion", snap50_1h);
      expect(res50_1h.isValid).toBe(false);
      expect(res50_1h.reason).toContain("INSUFFICIENT_1H_BARS (got 50, required >= 51)");

      // 50 on 4h -> fail
      const snap50_4h = buildMtfSnapshot({
        "5m": createCandles(51, "5m", BASE_TIME),
        "15m": createCandles(51, "15m", BASE_TIME),
        "1h": createCandles(51, "1h", BASE_TIME),
        "4h": createCandles(50, "4h", BASE_TIME),
      });
      const res50_4h = verifyStrategyDataContract("MeanReversion", snap50_4h);
      expect(res50_4h.isValid).toBe(false);
      expect(res50_4h.reason).toContain("INSUFFICIENT_4H_BARS (got 50, required >= 51)");

      // 51 on all 4 timeframes -> pass
      const snap51_all = buildMtfSnapshot({
        "5m": createCandles(51, "5m", BASE_TIME),
        "15m": createCandles(51, "15m", BASE_TIME),
        "1h": createCandles(51, "1h", BASE_TIME),
        "4h": createCandles(51, "4h", BASE_TIME),
      });
      const res51_all = verifyStrategyDataContract("MeanReversion", snap51_all);
      expect(res51_all.isValid).toBe(true);
    });

    it("28. manifest preserves MeanReversion identity with 4TF supported timeframes and 51 min candles", () => {
      expect(strategy.manifest.id).toBe("MeanReversion");
      expect(strategy.manifest.supportedTimeframes).toEqual(["5m", "15m", "1h", "4h"]);
      expect(strategy.manifest.minimumCandles).toBe(51);
      expect(strategy.manifest.supportsLong).toBe(true);
      expect(strategy.manifest.supportsShort).toBe(true);
      expect(strategy.manifest.category).toBe("Mean Reversion");
      expect(strategy.manifest.riskProfile).toBe("Medium");
    });
  });

  // ==========================================================================
  // 9. TRADING BOT DISPLAY RESULT RESOLUTION (Finding 3 Regression Tests)
  // ==========================================================================
  describe("TradingBot.resolveDisplayResult (Finding 3 Regression)", () => {
    const registry = StrategyRegistry.getInstance();

    const scalperResult: EvaluationResult = {
      strategyId: 'ScalperV2',
      timestamp: Date.now(),
      confidenceScore: 80,
      hasSignal: true,
      metadata: { reasoning: ['Scalper BUY signal'] }
    };

    const meanRevNoSignal: EvaluationResult = {
      strategyId: 'MeanReversion',
      timestamp: Date.now(),
      confidenceScore: 40,
      hasSignal: false,
      metadata: { reasoning: ['MeanReversion no signal'] }
    };

    const momentumSignal: EvaluationResult = {
      strategyId: 'Momentum',
      timestamp: Date.now(),
      confidenceScore: 85,
      hasSignal: true,
      metadata: { reasoning: ['Momentum BUY signal'] }
    };

    it("1. committed strategy with NO signal returns committed strategy result even when another strategy has a signal", () => {
      const results = [scalperResult, meanRevNoSignal];
      const resolved = TradingBot.resolveDisplayResult(results, 'MeanReversion', 'ScalperV2', registry);
      expect(resolved.strategyId).toBe('MeanReversion');
      expect(resolved.hasSignal).toBe(false);
      expect(resolved.metadata.reasoning).toContain('MeanReversion no signal');
    });

    it("2. alias and case normalization correctly resolves committed strategy", () => {
      const results = [scalperResult, meanRevNoSignal, momentumSignal];

      // Lowercase, hyphenated, and alias variations
      const testCases = [
        { raw: 'meanreversion', expected: 'MeanReversion' },
        { raw: 'mean-reversion', expected: 'MeanReversion' },
        { raw: 'reversion', expected: 'MeanReversion' },
        { raw: 'scalper', expected: 'ScalperV2' },
        { raw: 'scalper-v2', expected: 'ScalperV2' },
        { raw: 'scalperv2', expected: 'ScalperV2' },
        { raw: 'momentum', expected: 'Momentum' },
        { raw: 'breakout', expected: 'Breakout' },
        { raw: 'vwap', expected: 'VWAP' }
      ];

      for (const tc of testCases) {
        const normalized = registry.normalizeStrategyId(tc.raw);
        expect(normalized).toBe(tc.expected);
      }

      // Check display resolution with case variation
      const resLower = TradingBot.resolveDisplayResult(results, 'meanreversion', 'ScalperV2', registry);
      expect(resLower.strategyId).toBe('MeanReversion');

      const resHyphen = TradingBot.resolveDisplayResult(results, 'mean-reversion', 'ScalperV2', registry);
      expect(resHyphen.strategyId).toBe('MeanReversion');
    });

    it("3. missing committed result returns neutral fallback for committed strategy, never ScalperV2 fallback", () => {
      // Results only contain ScalperV2 and Momentum; MeanReversion was not evaluated
      const results = [scalperResult, momentumSignal];
      const resolved = TradingBot.resolveDisplayResult(results, 'MeanReversion', 'ScalperV2', registry);
      expect(resolved.strategyId).toBe('MeanReversion');
      expect(resolved.hasSignal).toBe(false);
      expect(resolved.metadata.reasoning).toContain('Evaluation pending');
    });

    it("4. uncommitted mode: prefers first strategy with signal, or falls back to first available", () => {
      const results = [meanRevNoSignal, scalperResult];
      // With uncommitted strategy (null / undefined), it should pick scalperResult because it hasSignal: true
      const resolved = TradingBot.resolveDisplayResult(results, null, 'ScalperV2', registry);
      expect(resolved.strategyId).toBe('ScalperV2');
      expect(resolved.hasSignal).toBe(true);

      // When neither has signal, falls back to results[0]
      const noSignalResults = [
        { ...meanRevNoSignal, strategyId: 'MeanReversion' },
        { ...scalperResult, hasSignal: false, strategyId: 'ScalperV2' }
      ];
      const resolvedFallback = TradingBot.resolveDisplayResult(noSignalResults, undefined, 'ScalperV2', registry);
      expect(resolvedFallback.strategyId).toBe('MeanReversion');
    });

    it("5. validates resolution for all five registered strategies", () => {
      const allFive: EvaluationResult[] = [
        { strategyId: 'ScalperV2', timestamp: Date.now(), confidenceScore: 50, hasSignal: false, metadata: { reasoning: [] } },
        { strategyId: 'Momentum', timestamp: Date.now(), confidenceScore: 50, hasSignal: false, metadata: { reasoning: [] } },
        { strategyId: 'Breakout', timestamp: Date.now(), confidenceScore: 50, hasSignal: false, metadata: { reasoning: [] } },
        { strategyId: 'MeanReversion', timestamp: Date.now(), confidenceScore: 50, hasSignal: false, metadata: { reasoning: [] } },
        { strategyId: 'VWAP', timestamp: Date.now(), confidenceScore: 50, hasSignal: false, metadata: { reasoning: [] } },
      ];

      for (const strat of ['ScalperV2', 'Momentum', 'Breakout', 'MeanReversion', 'VWAP']) {
        const resolved = TradingBot.resolveDisplayResult(allFive, strat, 'ScalperV2', registry);
        expect(resolved.strategyId).toBe(strat);
      }
    });
  });

  // ==========================================================================
  // 10. FAIL-CLOSED VALIDATION HARDENING (Tests 29 - 34)
  // ==========================================================================
  describe("Fail-Closed Validation Hardening", () => {
    it("29. fails closed without throwing on invalid context timestamp, blank/missing symbol, non-array rawCandles, or null candle entry", () => {
      const validSnap = createDefaultMtfSnapshot();

      const badTsContext = {
        timestamp: Number.NaN,
        accountBalance: 10000,
        marketSnapshot: { ...validSnap, timestamp: Number.NaN },
      } as unknown as Readonly<StrategyContext>;
      const resBadTs = strategy.evaluate(badTsContext, "5m");
      expect(resBadTs.hasSignal).toBe(false);
      expect(resBadTs.timestamp).toBe(0);
      expect(resBadTs.metadata.reasoning[0]).toContain("Invalid evaluation timestamp");

      const infTsContext = {
        timestamp: Number.POSITIVE_INFINITY,
        accountBalance: 10000,
        marketSnapshot: { ...validSnap, timestamp: Number.POSITIVE_INFINITY },
      } as unknown as Readonly<StrategyContext>;
      const resInfTs = strategy.evaluate(infTsContext, "5m");
      expect(resInfTs.hasSignal).toBe(false);
      expect(resInfTs.metadata.reasoning[0]).toContain("Invalid evaluation timestamp");

      const blankSymSnap = createDefaultMtfSnapshot();
      (blankSymSnap as any).symbol = "   ";
      const resBlankSym = strategy.evaluate(new StrategyContext(blankSymSnap, 10000).freeze(), "5m");
      expect(resBlankSym.hasSignal).toBe(false);
      expect(resBlankSym.metadata.reasoning[0]).toContain("Missing or invalid symbol");

      const nonArraySnap = buildMtfSnapshot({}, BASE_TIME);
      (nonArraySnap.candles as any)["5m"] = { length: 60 };
      const resNonArray = strategy.evaluate(new StrategyContext(nonArraySnap, 10000).freeze(), "5m");
      expect(resNonArray.hasSignal).toBe(false);
      expect(resNonArray.metadata.reasoning[0]).toContain("Missing required candle data");

      const nullElementCandles = createCandles(60, "5m", BASE_TIME);
      (nullElementCandles as any)[10] = null;
      const nullElemSnap = buildMtfSnapshot({ "5m": nullElementCandles }, BASE_TIME);
      const resNullElem = strategy.evaluate(new StrategyContext(nullElemSnap, 10000).freeze(), "5m");
      expect(resNullElem.hasSignal).toBe(false);
      expect(resNullElem.metadata.reasoning[0]).toContain("Invalid candle timestamp");
    });

    it("30. rejects missing, zero, negative, or non-finite candle timestamps and clears pending recovery", () => {
      const freshStrategy = new MeanReversionStrategy();
      const tf5mMs = 5 * 60 * 1000;
      const t0 = BASE_TIME - tf5mMs;
      const t1 = BASE_TIME;
      const t2 = BASE_TIME + tf5mMs;

      // Bar T1: BUY setup transiently rejected for zero balance -> populates rejectedEdgeEvents
      const snapT1 = createDefaultMtfSnapshot(60, t1);
      mockIndicators(freshStrategy, {
        rsiByTimestamp: {
          [t0]: [50, 50],
          [t1]: [22, 28],
          [t2]: [22, 28],
        },
      });
      freshStrategy.evaluate(createZeroBalanceContext(snapT1), "5m");
      expect((freshStrategy as any).rejectedEdgeEvents.size).toBe(1);

      const baseCandles = createCandles(61, "5m", t2);
      const badTimestamps = [
        baseCandles.map((c, idx) => idx === 5 ? { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume } as any : c),
        baseCandles.map((c, idx) => idx === 60 ? { ...c, closeTime: Number.NaN } : c),
        baseCandles.map((c, idx) => idx === 60 ? { ...c, closeTime: Number.POSITIVE_INFINITY } : c),
        baseCandles.map((c, idx) => idx === 0 ? { ...c, openTime: 0, timestamp: 0 } : c),
        baseCandles.map((c, idx) => idx === 1 ? { ...c, openTime: -100, timestamp: -100 } : c),
      ];

      for (let i = 0; i < badTimestamps.length; i++) {
        const strat = i === 0 ? freshStrategy : new MeanReversionStrategy();
        const badSnap = buildMtfSnapshot({ "5m": badTimestamps[i] }, t2);
        const res = strat.evaluate(new StrategyContext(badSnap, 10000).freeze(), "5m");
        expect(res.hasSignal).toBe(false);
        expect(res.metadata.reasoning[0]).toContain("Invalid candle timestamp");
        if (i === 0) {
          expect((freshStrategy as any).rejectedEdgeEvents.size).toBe(0);
        }
      }
    });

    it("31. fails closed on non-finite OHLC, high < low, negative/non-finite volume, earlier non-positive OHLC, and invalid close without ticker fallback", () => {
      const freshStrategy = new MeanReversionStrategy();
      mockIndicators(freshStrategy, { currentRsi5m: 28, previousRsi5m: 22 });

      const baseCandles = createCandles(60, "5m", BASE_TIME);
      const badSeries = [
        baseCandles.map((c, idx) => idx === 59 ? { ...c, close: Number.NaN } : c),
        baseCandles.map((c, idx) => idx === 59 ? { ...c, high: Number.POSITIVE_INFINITY } : c),
        baseCandles.map((c, idx) => idx === 10 ? { ...c, low: Number.NEGATIVE_INFINITY } : c),
        baseCandles.map((c, idx) => idx === 15 ? { ...c, high: 95, low: 105 } : c),
        baseCandles.map((c, idx) => idx === 20 ? { ...c, volume: -1 } : c),
        baseCandles.map((c, idx) => idx === 25 ? { ...c, volume: Number.POSITIVE_INFINITY } : c),
        baseCandles.map((c, idx) => idx === 5 ? { ...c, open: 0, low: 0 } : c),
        baseCandles.map((c, idx) => idx === 5 ? { ...c, close: -5 } : c),
      ];

      for (const series of badSeries) {
        const snap = buildMtfSnapshot({ "5m": series }, BASE_TIME, 100);
        const res = freshStrategy.evaluate(new StrategyContext(snap, 10000).freeze(), "5m");
        expect(res.hasSignal).toBe(false);
        expect(res.metadata.reasoning[0]).toContain("Invalid OHLC candle data");
      }

      // Zero close on latest closed candle must fail closed with "Invalid current price" even with valid snapshot.currentPrice > 0
      const latestZero = createCandles(60, "5m", BASE_TIME).map((c, idx) =>
        idx === 59 ? { ...c, open: 100, high: 101, low: 0, close: 0 } : c
      );
      const latestZeroSnap = buildMtfSnapshot({ "5m": latestZero }, BASE_TIME, 50000);
      const resLatestZero = freshStrategy.evaluate(new StrategyContext(latestZeroSnap, 10000).freeze(), "5m");
      expect(resLatestZero.hasSignal).toBe(false);
      expect(resLatestZero.metadata.reasoning.some((r: string) => r.includes("Invalid current price"))).toBe(true);
    });

    it("32. rejects Infinity/-Infinity EMA separation and Infinity/-Infinity RSI values fail-closed", () => {
      const snap = createDefaultMtfSnapshot();

      // Infinity EMA20
      const infEmaStrategy = new MeanReversionStrategy();
      vi.spyOn((infEmaStrategy as any).indicatorEngine, "evaluate").mockImplementation((snapshot: any) => ({
        timestamp: snapshot.timestamp,
        timeframes: {
          "5m": {
            close: [100, 100],
            sma: {},
            ema: { 20: [Number.POSITIVE_INFINITY], 50: [100] },
            rsi: { 14: snapshot.timestamp < BASE_TIME ? [50, 50] : [22, 28] },
            macd: { "12,26,9": [] },
            atr: { 14: [2.0] },
            volume: [1000],
          },
        },
      } as any));
      const resInfEma = infEmaStrategy.evaluate(new StrategyContext(snap, 10000).freeze(), "5m");
      expect(resInfEma.hasSignal).toBe(false);
      expect(resInfEma.metadata.reasoning.some((r: string) => r.includes("EMA contains invalid or non-finite values"))).toBe(true);

      // -Infinity / +Infinity RSI14
      const infRsiStrategy = new MeanReversionStrategy();
      mockIndicators(infRsiStrategy, { previousRsi5m: Number.NEGATIVE_INFINITY, currentRsi5m: 30 });
      const resNegInfRsi = infRsiStrategy.evaluate(new StrategyContext(snap, 10000).freeze(), "5m");
      expect(resNegInfRsi.hasSignal).toBe(false);
      expect(resNegInfRsi.metadata.reasoning.some((r: string) => r.includes("RSI contains invalid or non-finite values"))).toBe(true);

      mockIndicators(infRsiStrategy, { previousRsi5m: 80, currentRsi5m: Number.POSITIVE_INFINITY });
      const resPosInfRsi = infRsiStrategy.evaluate(new StrategyContext(snap, 10000).freeze(), "5m");
      expect(resPosInfRsi.hasSignal).toBe(false);
      expect(resPosInfRsi.metadata.reasoning.some((r: string) => r.includes("RSI contains invalid or non-finite values"))).toBe(true);
    });

    it("33. rejects Infinity/-Infinity/negative accountBalance, Infinity ATR (without polluting recovery), and invalid allowedRiskClassifications", () => {
      const snap = createDefaultMtfSnapshot();

      // Infinity / negative / NaN accountBalance (bypassing StrategyContext default fallback)
      const balStrategy = new MeanReversionStrategy();
      mockIndicators(balStrategy, { currentRsi5m: 28, previousRsi5m: 22 });
      for (const badBal of [Number.POSITIVE_INFINITY, Number.NaN, -500]) {
        const badBalCtx = {
          timestamp: snap.timestamp,
          marketSnapshot: snap,
          accountBalance: badBal,
        } as unknown as Readonly<StrategyContext>;
        const res = balStrategy.evaluate(badBalCtx, "5m");
        expect(res.hasSignal).toBe(false);
        expect(res.metadata.reasoning[0]).toContain("Account balance is zero or unconfigured");
        expect((balStrategy as any).rejectedEdgeEvents.size).toBe(0);
      }

      // Infinity ATR must fail closed BEFORE RiskEngine and clear any prior pending recovery
      const atrStrategy = new MeanReversionStrategy();
      const tf5mMs = 5 * 60 * 1000;
      const t0 = BASE_TIME - tf5mMs;
      const t1 = BASE_TIME;
      const t2 = BASE_TIME + tf5mMs;

      mockIndicators(atrStrategy, {
        rsiByTimestamp: {
          [t0]: [50, 50],
          [t1]: [22, 28],
          [t2]: [22, 28],
        },
        atr5m: 2.0,
      });
      atrStrategy.evaluate(createZeroBalanceContext(createDefaultMtfSnapshot(60, t1)), "5m");
      expect((atrStrategy as any).rejectedEdgeEvents.size).toBe(1);

      mockIndicators(atrStrategy, {
        rsiByTimestamp: {
          [t0]: [50, 50],
          [t1]: [22, 28],
          [t2]: [22, 28],
        },
        atr5m: Number.POSITIVE_INFINITY,
      });
      const resInfAtr = atrStrategy.evaluate(new StrategyContext(createDefaultMtfSnapshot(61, t2), 10000).freeze(), "5m");
      expect(resInfAtr.hasSignal).toBe(false);
      expect(resInfAtr.metadata.reasoning.some((r: string) => r.includes("ATR is zero or unavailable"))).toBe(true);
      expect((atrStrategy as any).rejectedEdgeEvents.size).toBe(0);

      // Missing/non-array allowedRiskClassifications must fail closed without throwing
      const badConfig = {
        ...DEFAULT_MEAN_REVERSION_CONFIG,
        signalRules: {
          ...DEFAULT_MEAN_REVERSION_CONFIG.signalRules,
          allowedRiskClassifications: undefined as any,
        },
      };
      const cfgStrategy = new MeanReversionStrategy(badConfig);
      mockIndicators(cfgStrategy, { currentRsi5m: 28, previousRsi5m: 22 });
      const resBadCfg = cfgStrategy.evaluate(new StrategyContext(snap, 10000).freeze(), "5m");
      expect(resBadCfg.hasSignal).toBe(false);
      expect(resBadCfg.metadata.reasoning.some((r: string) => r.includes("Allowed risk classifications configuration is missing"))).toBe(true);
    });

    it("34. fails closed if RiskEngine outputs non-finite, zero, or non-positive SL/TP/sizing values", () => {
      const snap = createDefaultMtfSnapshot();
      const riskMutators = [
        { riskClassification: "LOW", stopLossDistance: 0, takeProfitDistance: 5, maximumExposure: 10, positionSizeRecommendation: 10, explanation: [] },
        { riskClassification: "LOW", stopLossDistance: 150, takeProfitDistance: 5, maximumExposure: 10, positionSizeRecommendation: 10, explanation: [] }, // BUY SL = 100 - 150 <= 0
        { riskClassification: "LOW", stopLossDistance: 2, takeProfitDistance: Number.POSITIVE_INFINITY, maximumExposure: 10, positionSizeRecommendation: 10, explanation: [] },
        { riskClassification: "LOW", stopLossDistance: 2, takeProfitDistance: 5, maximumExposure: 10, positionSizeRecommendation: 0, explanation: [] },
        { riskClassification: "LOW", stopLossDistance: 2, takeProfitDistance: 5, maximumExposure: Number.NaN, positionSizeRecommendation: 10, explanation: [] },
      ];

      for (const badRisk of riskMutators) {
        const strat = new MeanReversionStrategy();
        mockIndicators(strat, { currentRsi5m: 28, previousRsi5m: 22 });
        vi.spyOn((strat as any).riskEngine, "evaluate").mockReturnValue(badRisk as any);

        const res = strat.evaluate(new StrategyContext(snap, 10000).freeze(), "5m");
        expect(res.hasSignal).toBe(false);
        expect(res.metadata.signal).toBeNull();
        expect(res.metadata.reasoning.some((r: string) => r.includes("Invalid risk/SL/TP parameters"))).toBe(true);
      }
    });
  });
});
