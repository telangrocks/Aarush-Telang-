import { describe, it, expect, vi } from "vitest";
import { MeanReversionStrategy } from "./MeanReversionStrategy";
import { DEFAULT_MEAN_REVERSION_CONFIG } from "./MeanReversionConfig";
import { StrategyContext } from "../../context/StrategyContext";
import { MarketSnapshot, NormalizedCandle } from "../../market-data/MarketSnapshot";
import { SignalType } from "../../signal";
import { CandleValidator } from "../../../infrastructure/exchange/CandleValidator";
import { verifyStrategyDataContract } from "../../matrix/MatrixEvaluator";

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

function mockIndicators(
  strategy: MeanReversionStrategy,
  options: {
    sep4h?: number;
    sep1h?: number;
    sep15m?: number;
    atr15m?: number;
    currentRsi5m?: number;
    previousRsi5m?: number;
    prevSnapshotRsiCurr?: number;
    prevSnapshotRsiPrev?: number;
  } = {}
) {
  const {
    sep4h = 1.0,
    sep1h = 1.0,
    sep15m = 1.0,
    atr15m = 2.0,
    currentRsi5m = 28,
    previousRsi5m = 22,
    prevSnapshotRsiCurr = 50,
    prevSnapshotRsiPrev = 50
  } = options;

  vi.spyOn((strategy as any).indicatorEngine, "evaluate").mockImplementation((snapshot: any) => {
    const isPrev = snapshot.timestamp < BASE_TIME;
    const rsiCurr = isPrev ? prevSnapshotRsiCurr : currentRsi5m;
    const rsiPrev = isPrev ? prevSnapshotRsiPrev : previousRsi5m;

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
          atr: { 14: [1.0] },
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
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning[0]).toContain("Insufficient closed candle data for timeframe 5m");
    });

    it("2. missing 4H -> NO SIGNAL", () => {
      const snap = buildMtfSnapshot({
        "5m": createCandles(60, "5m", BASE_TIME),
        "15m": createCandles(60, "15m", BASE_TIME),
        "1h": createCandles(60, "1h", BASE_TIME),
        "4h": [],
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning[0]).toContain("Missing required candle data for timeframe 4h");
    });

    it("3. missing 1H -> NO SIGNAL", () => {
      const snap = buildMtfSnapshot({
        "5m": createCandles(60, "5m", BASE_TIME),
        "15m": createCandles(60, "15m", BASE_TIME),
        "1h": [],
        "4h": createCandles(60, "4h", BASE_TIME),
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning[0]).toContain("Missing required candle data for timeframe 1h");
    });

    it("4. missing 15M -> NO SIGNAL", () => {
      const snap = buildMtfSnapshot({
        "5m": createCandles(60, "5m", BASE_TIME),
        "15m": [],
        "1h": createCandles(60, "1h", BASE_TIME),
        "4h": createCandles(60, "4h", BASE_TIME),
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning[0]).toContain("Missing required candle data for timeframe 15m");
    });

    it("5. missing 5M -> NO SIGNAL", () => {
      const snap = buildMtfSnapshot({
        "5m": [],
        "15m": createCandles(60, "15m", BASE_TIME),
        "1h": createCandles(60, "1h", BASE_TIME),
        "4h": createCandles(60, "4h", BASE_TIME),
      });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);
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
      const res = strategy.evaluate(ctx);

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
    it("7. 4H separation > 5% -> NO SIGNAL", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { sep4h: 5.5, sep1h: 1.0, sep15m: 1.0, currentRsi5m: 28, previousRsi5m: 22 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning.some((r: string) => r.includes("[MTF RUNAWAY] Structural Bias (4h)"))).toBe(true);
    });

    it("8. 1H separation > 5% -> NO SIGNAL", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { sep4h: 1.0, sep1h: 6.2, sep15m: 1.0, currentRsi5m: 28, previousRsi5m: 22 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning.some((r: string) => r.includes("[MTF RUNAWAY] Macro Trend (1h)"))).toBe(true);
    });

    it("9. 15M separation > 5% -> NO SIGNAL", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { sep4h: 1.0, sep1h: 1.0, sep15m: 5.8, currentRsi5m: 28, previousRsi5m: 22 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning.some((r: string) => r.includes("[MTF RUNAWAY] Intermediate Setup & Risk Anchor (15m)"))).toBe(true);
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
      const res = strategy.evaluate(ctx);
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
      const res = strategy.evaluate(ctx);
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
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning.some((r: string) => r.includes("No valid 5m RSI reversal curl"))).toBe(true);
    });
  });

  // ==========================================================================
  // 4. DIRECTIONAL INTEGRITY (Tests 13 - 15)
  // ==========================================================================
  describe("Directional Integrity & Non-Blocking Confidence", () => {
    it("13. bearish/trend-following ConfidenceEngine scores MUST NOT convert a valid MR BUY into NO SIGNAL", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22 });

      // Mock ConfidenceEngine emitting strong BEARISH scores (trend-following model thinks market is falling)
      vi.spyOn((strategy as any).confidenceEngine, "evaluate").mockReturnValue({
        timestamp: BASE_TIME,
        overallScore: 20,
        overallLongScore: 10,
        overallShortScore: 90,
        timeframes: {
          "5m": { score: 20, longScore: 10, shortScore: 90 }
        }
      } as any);

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);

      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
    });

    it("14. bullish/trend-following ConfidenceEngine scores MUST NOT convert a valid MR SELL into NO SIGNAL", () => {
      const snap = createDefaultMtfSnapshot();
      mockIndicators(strategy, { currentRsi5m: 72, previousRsi5m: 78 });

      // Mock ConfidenceEngine emitting strong BULLISH scores (trend-following model thinks market is rallying)
      vi.spyOn((strategy as any).confidenceEngine, "evaluate").mockReturnValue({
        timestamp: BASE_TIME,
        overallScore: 85,
        overallLongScore: 90,
        overallShortScore: 10,
        timeframes: {
          "5m": { score: 85, longScore: 90, shortScore: 10 }
        }
      } as any);

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);

      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.SELL);
    });

    it("15. ConfidenceEngine scores do not determine BUY versus SELL", () => {
      const snap = createDefaultMtfSnapshot();
      // 5M RSI indicates SELL curl
      mockIndicators(strategy, { currentRsi5m: 71, previousRsi5m: 77 });

      // Even if ConfidenceEngine has 100 longScore, MR reversal logic determines SELL
      vi.spyOn((strategy as any).confidenceEngine, "evaluate").mockReturnValue({
        timestamp: BASE_TIME,
        overallScore: 100,
        overallLongScore: 100,
        overallShortScore: 0,
        timeframes: {
          "5m": { score: 100, longScore: 100, shortScore: 0 }
        }
      } as any);

      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);

      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.SELL);
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
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
      expect(res.metadata.reasoning.some((r: string) => r.includes("[MTF EDGE EVENT] New BUY event"))).toBe(true);
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
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning.some((r: string) => r.includes("[MTF CONTINUATION] Trend continuation suppressed"))).toBe(true);
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
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.SELL);
      expect(res.metadata.reasoning.some((r: string) => r.includes("[MTF EDGE EVENT] New SELL event"))).toBe(true);
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
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
      expect(res.metadata.reasoning.some((r: string) => r.includes("[MTF CONTINUATION] Trend continuation suppressed"))).toBe(true);
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
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.SELL);
      expect(res.metadata.reasoning.some((r: string) => r.includes("[MTF EDGE EVENT] New SELL event"))).toBe(true);
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
      const res = strategy.evaluate(ctx);
      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.type).toBe(SignalType.BUY);
      expect(res.metadata.reasoning.some((r: string) => r.includes("[MTF EDGE EVENT] New BUY event"))).toBe(true);
    });
  });

  // ==========================================================================
  // 6. RISK & SIZING (Tests 22 - 26)
  // ==========================================================================
  describe("Risk & Sizing Anchored to 15M ATR", () => {
    it("22. 15M ATR14 is used (not 5m)", () => {
      const snap = createDefaultMtfSnapshot();
      // 15m ATR is 4.0, 5m ATR is 1.0
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22, atr15m: 4.0 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);

      expect(res.hasSignal).toBe(true);
      // Stop loss distance should be 4.0 * 1.2 = 4.8
      expect(res.metadata.signal?.riskAssessment.stopLossDistance).toBeCloseTo(4.8, 4);
    });

    it("23. SL = 1.2x ATR", () => {
      const snap = createDefaultMtfSnapshot(60, BASE_TIME);
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22, atr15m: 5.0 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);

      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.riskAssessment.stopLossDistance).toBeCloseTo(6.0, 4); // 5.0 * 1.2
      // For BUY at price 100, SL = 100 - 6.0 = 94
      expect(res.metadata.signal?.stopLoss).toBeCloseTo(94.0, 4);
    });

    it("24. TP = 2.5x ATR", () => {
      const snap = createDefaultMtfSnapshot(60, BASE_TIME);
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22, atr15m: 5.0 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);

      expect(res.hasSignal).toBe(true);
      expect(res.metadata.signal?.riskAssessment.takeProfitDistance).toBeCloseTo(12.5, 4); // 5.0 * 2.5
      // For BUY at price 100, TP = 100 + 12.5 = 112.5
      expect(res.metadata.signal?.takeProfit).toBeCloseTo(112.5, 4);
    });

    it("25. exposure <= 10%", () => {
      const snap = createDefaultMtfSnapshot(60, BASE_TIME);
      mockIndicators(strategy, { currentRsi5m: 28, previousRsi5m: 22 });
      const ctx = new StrategyContext(snap, 10000).freeze();
      const res = strategy.evaluate(ctx);

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
      const res = strategy.evaluate(ctx);

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
});
