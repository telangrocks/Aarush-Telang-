import { describe, it, expect } from 'vitest';
import { ScalperV2Strategy } from './ScalperV2Strategy';
import { DEFAULT_SCALPER_CONFIG } from './ScalperV2Config';
import { StrategyContext } from '../../context/StrategyContext';
import { MarketSnapshot, NormalizedCandle } from '../../market-data/MarketSnapshot';
import { SignalType } from '../../signal';
import { CandleValidator } from '../../../infrastructure/exchange/CandleValidator';

// Canonical reference time aligned to 4h boundary
const BASE_TIME = 1789000000000 - (1789000000000 % (4 * 3600 * 1000));

function createBullishCandles(
  count = 35,
  basePrice = 100,
  tf: '5m' | '15m' | '1h' | '4h' = '5m',
  endTimestamp = BASE_TIME
): NormalizedCandle[] {
  const tfMs = CandleValidator.timeframeToMs(tf);
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = endTimestamp - (count - i) * tfMs;
    const p = basePrice + i * 1.5;
    // Volatility expansion on recent bars:
    const spread = 2 + (i >= count - 4 ? (i - (count - 4) + 1) * 0.5 : 0);
    // Volume breakout surge on final bars (> 20% surge) with increasing trend:
    const vol = 1000 + i * 20 + (i === count - 1 ? 1500 : i === count - 2 ? 800 : 0);
    candles.push({
      timestamp: openTime,
      openTime,
      open: p - 1,
      high: p + spread,
      low: p - spread,
      close: p,
      volume: vol
    });
  }
  return candles;
}

function createBearishCandles(
  count = 35,
  basePrice = 150,
  tf: '5m' | '15m' | '1h' | '4h' = '5m',
  endTimestamp = BASE_TIME
): NormalizedCandle[] {
  const tfMs = CandleValidator.timeframeToMs(tf);
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = endTimestamp - (count - i) * tfMs;
    const p = basePrice - i * 1.5;
    const spread = 2 + (i >= count - 4 ? (i - (count - 4) + 1) * 0.5 : 0);
    const vol = 1000 + i * 20 + (i === count - 1 ? 1500 : i === count - 2 ? 800 : 0);
    candles.push({
      timestamp: openTime,
      openTime,
      open: p + 1,
      high: p + spread,
      low: p - spread,
      close: p,
      volume: vol
    });
  }
  return candles;
}

function createFlatCandles(
  count = 35,
  basePrice = 100,
  tf: '5m' | '15m' | '1h' | '4h' = '5m',
  endTimestamp = BASE_TIME
): NormalizedCandle[] {
  const tfMs = CandleValidator.timeframeToMs(tf);
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = endTimestamp - (count - i) * tfMs;
    candles.push({
      timestamp: openTime,
      openTime,
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
    '5m'?: NormalizedCandle[];
    '15m'?: NormalizedCandle[];
    '1h'?: NormalizedCandle[];
    '4h'?: NormalizedCandle[];
  },
  symbol = 'BTC/USDT',
  currentPrice?: number,
  timestamp = BASE_TIME
): MarketSnapshot {
  const latest5m = candlesByTf['5m'];
  const price = currentPrice ?? (latest5m && latest5m.length > 0 ? latest5m[latest5m.length - 1].close : 100);

  return {
    symbol,
    timestamp,
    currentPrice: price,
    volume24h: 10000,
    quoteVolume24h: 10000 * price,
    metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: price + 10, lowPrice24h: price - 10 },
    candles: {
      '5m': (candlesByTf['5m'] || []) as any,
      '15m': (candlesByTf['15m'] || []) as any,
      '1h': (candlesByTf['1h'] || []) as any,
      '4h': (candlesByTf['4h'] || []) as any,
    } as any
  };
}

describe('ScalperV2Strategy — Multi-Timeframe (5m + 15m + 1h + 4h) Test Suite', () => {
  // Authoritative production strategy instance with minConfidenceScore = 75
  const strategy = new ScalperV2Strategy();

  // --------------------------------------------------------------------------
  // TEST 1: Full Bullish Alignment
  // --------------------------------------------------------------------------
  it('1. Full bullish alignment: 4h LONG + 1h LONG + 15m LONG + 5m BUY -> BUY', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100, '5m'),
      '15m': createBullishCandles(35, 100, '15m'),
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(true);
    expect(result.metadata.signal).not.toBeNull();
    expect(result.metadata.signal?.type).toBe(SignalType.BUY);
    expect(result.metadata.reasoning.some((r: string) => r.includes('[MTF CONFIRMED]'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 2: Full Bearish Alignment
  // --------------------------------------------------------------------------
  it('2. Full bearish alignment: 4h SHORT + 1h SHORT + 15m SHORT + 5m SELL -> SELL', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBearishCandles(35, 150, '5m'),
      '15m': createBearishCandles(35, 150, '15m'),
      '1h': createBearishCandles(35, 150, '1h'),
      '4h': createBearishCandles(35, 150, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(true);
    expect(result.metadata.signal).not.toBeNull();
    expect(result.metadata.signal?.type).toBe(SignalType.SELL);
    expect(result.metadata.reasoning.some((r: string) => r.includes('[MTF CONFIRMED]'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 3: 15m Conflict
  // --------------------------------------------------------------------------
  it('3. 15m conflict: 4h LONG + 1h LONG + 15m SHORT + 5m BUY -> NO TRADE', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100, '5m'),
      '15m': createBearishCandles(35, 150, '15m'), // Contradicts LONG
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('15m Intermediate Momentum') && r.includes('contradicts BUY'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 4: 1h Conflict
  // --------------------------------------------------------------------------
  it('4. 1h conflict: 4h LONG + 1h SHORT + 15m LONG + 5m BUY -> NO TRADE', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100, '5m'),
      '15m': createBullishCandles(35, 100, '15m'),
      '1h': createBearishCandles(35, 150, '1h'), // Contradicts LONG
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('1h Macro Trend') && r.includes('contradicts BUY'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 5: 4h Conflict
  // --------------------------------------------------------------------------
  it('5. 4h conflict: 4h SHORT + 1h LONG + 15m LONG + 5m BUY -> NO TRADE', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100, '5m'),
      '15m': createBullishCandles(35, 100, '15m'),
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBearishCandles(35, 150, '4h'), // Contradicts LONG
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('4h Structural Bias') && r.includes('contradicts BUY'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 6: 5m Conflict
  // --------------------------------------------------------------------------
  it('6. 5m conflict: 4h LONG + 1h LONG + 15m LONG + 5m SELL -> NO TRADE', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBearishCandles(35, 150, '5m'), // 5m generates SELL
      '15m': createBullishCandles(35, 100, '15m'), // higher timeframes are LONG
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('contradicts SELL'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 7: Missing 15m
  // --------------------------------------------------------------------------
  it('7. Missing 15m: 15m missing from market snapshot -> NO TRADE', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100, '5m'),
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('Missing required candle data for timeframe 15m'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 8: Missing 1h
  // --------------------------------------------------------------------------
  it('8. Missing 1h: 1h missing from market snapshot -> NO TRADE', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100, '5m'),
      '15m': createBullishCandles(35, 100, '15m'),
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('Missing required candle data for timeframe 1h'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 9: Missing 4h
  // --------------------------------------------------------------------------
  it('9. Missing 4h: 4h missing from market snapshot -> NO TRADE', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100, '5m'),
      '15m': createBullishCandles(35, 100, '15m'),
      '1h': createBullishCandles(35, 100, '1h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('Missing required candle data for timeframe 4h'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 10: Candle Depth Boundaries (34 vs 35)
  // --------------------------------------------------------------------------
  it('10a. Insufficient candles boundary: 15m has 34 candles (< 35) -> NO TRADE', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100, '5m'),
      '15m': createBullishCandles(34, 100, '15m'), // Exactly 34 candles: under 35 requirement
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('Insufficient closed candle data for timeframe 15m (got 34, required >= 35)'))).toBe(true);
  });

  it('10b. Insufficient candles boundary: 5m has 34 candles (< 35) -> NO TRADE', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(34, 100, '5m'), // Exactly 34 candles: under 35 requirement
      '15m': createBullishCandles(35, 100, '15m'),
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('Insufficient closed candle data for timeframe 5m (got 34, required >= 35)'))).toBe(true);
  });

  it('10c. Candle depth threshold boundary: all 4 timeframes have exactly 35 candles -> eligible to proceed and qualifies BUY', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100, '5m'),
      '15m': createBullishCandles(35, 100, '15m'),
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(true);
    expect(result.metadata.signal).not.toBeNull();
    expect(result.metadata.signal?.type).toBe(SignalType.BUY);
  });

  // --------------------------------------------------------------------------
  // TEST 11: Existing 5m Confidence Boundary
  // --------------------------------------------------------------------------
  it('11. Existing 5m confidence boundary: weak 5m momentum produces NO TRADE even with bullish higher TFs', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createFlatCandles(35, 100, '5m'), // Weak momentum on 5m trigger
      '15m': createBullishCandles(35, 100, '15m'),
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('No qualified signal generated on 5m trigger'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 12: Existing Risk Behavior
  // --------------------------------------------------------------------------
  it('12. Existing risk behavior: SL and TP are calculated strictly from 5m ATR (1.5x SL, 2.0x TP)', () => {
    const candles5m = createBullishCandles(35, 100, '5m');
    const snapshot = buildMtfSnapshot({
      '5m': candles5m,
      '15m': createBullishCandles(35, 100, '15m'),
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBullishCandles(35, 100, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(true);
    const sig = result.metadata.signal!;
    expect(sig.type).toBe(SignalType.BUY);

    const currentPrice = candles5m[candles5m.length - 1].close;
    expect(sig.entryPrice).toBe(currentPrice);

    const currentAtr = result.metadata.indicatorSnapshot.timeframes['5m'].atr[14].slice(-1)[0];
    expect(currentAtr).toBeGreaterThan(0);
    expect(sig.stopLoss).toBeCloseTo(currentPrice - (currentAtr * 1.5), 4);
    expect(sig.takeProfit).toBeCloseTo(currentPrice + (currentAtr * 2.0), 4);
    expect(sig.riskAssessment.riskClassification).toBe('LOW');
  });

  // --------------------------------------------------------------------------
  // PROOF OF CAUSAL RELEVANCE: EACH TIMEFRAME ALONE CHANGES OUTCOME
  // --------------------------------------------------------------------------
  describe('Proof of Causal Relevance: Each Timeframe Is Causally Active', () => {
    const baseBullish = {
      '5m': createBullishCandles(35, 100, '5m'),
      '15m': createBullishCandles(35, 100, '15m'),
      '1h': createBullishCandles(35, 100, '1h'),
      '4h': createBullishCandles(35, 100, '4h'),
    };

    it('Proof A: Changing ONLY 4h flips outcome from BUY to NO TRADE', () => {
      const resBase = strategy.evaluate(new StrategyContext(buildMtfSnapshot(baseBullish), 10000).freeze());
      expect(resBase.hasSignal).toBe(true);
      expect(resBase.metadata.signal?.type).toBe(SignalType.BUY);

      const snapInvert4h = buildMtfSnapshot({
        ...baseBullish,
        '4h': createBearishCandles(35, 150, '4h'),
      });
      const resInvert4h = strategy.evaluate(new StrategyContext(snapInvert4h, 10000).freeze());
      expect(resInvert4h.hasSignal).toBe(false);
      expect(resInvert4h.metadata.signal).toBeNull();
    });

    it('Proof B: Changing ONLY 1h flips outcome from BUY to NO TRADE', () => {
      const snapInvert1h = buildMtfSnapshot({
        ...baseBullish,
        '1h': createBearishCandles(35, 150, '1h'),
      });
      const resInvert1h = strategy.evaluate(new StrategyContext(snapInvert1h, 10000).freeze());
      expect(resInvert1h.hasSignal).toBe(false);
      expect(resInvert1h.metadata.signal).toBeNull();
    });

    it('Proof C: Changing ONLY 15m flips outcome from BUY to NO TRADE', () => {
      const snapInvert15m = buildMtfSnapshot({
        ...baseBullish,
        '15m': createBearishCandles(35, 150, '15m'),
      });
      const resInvert15m = strategy.evaluate(new StrategyContext(snapInvert15m, 10000).freeze());
      expect(resInvert15m.hasSignal).toBe(false);
      expect(resInvert15m.metadata.signal).toBeNull();
    });

    it('Proof D: Changing ONLY 5m flips outcome from BUY to NO TRADE', () => {
      const snapInvert5m = buildMtfSnapshot({
        ...baseBullish,
        '5m': createFlatCandles(35, 100, '5m'),
      });
      const resInvert5m = strategy.evaluate(new StrategyContext(snapInvert5m, 10000).freeze());
      expect(resInvert5m.hasSignal).toBe(false);
      expect(resInvert5m.metadata.signal).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // TEST: Short Suppression When Long-Only
  // --------------------------------------------------------------------------
  it('suppresses SELL signal when supportsShort is explicitly false', () => {
    const longOnlyStrategy = new ScalperV2Strategy();
    (longOnlyStrategy as any).manifest = { ...longOnlyStrategy.manifest, supportsShort: false };

    const snapshot = buildMtfSnapshot({
      '5m': createBearishCandles(35, 150, '5m'),
      '15m': createBearishCandles(35, 150, '15m'),
      '1h': createBearishCandles(35, 150, '1h'),
      '4h': createBearishCandles(35, 150, '4h'),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = longOnlyStrategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('Short signal suppressed'))).toBe(true);
  });

  // ==========================================================================
  // MANDATORY CLOSED-CANDLE FORENSIC VERIFICATION TESTS
  // ==========================================================================
  describe('Closed-Candle Architecture & Reference Time T Verification', () => {
    it('ignores active forming candle on 5m and anchors entry price to latest finalized closed candle', () => {
      const closed5m = createBullishCandles(35, 100, '5m');
      const latestClosed = closed5m[closed5m.length - 1];

      // Add a 36th forming candle that is actively incomplete and wildly spiking
      const formingCandle: NormalizedCandle = {
        openTime: BASE_TIME,
        timestamp: BASE_TIME,
        open: 500,
        high: 600,
        low: 400,
        close: 550, // Massive spike on unclosed candle
        volume: 99999,
      };

      const raw5mWithForming = [...closed5m, formingCandle];

      const snapshot = buildMtfSnapshot({
        '5m': raw5mWithForming,
        '15m': createBullishCandles(35, 100, '15m'),
        '1h': createBullishCandles(35, 100, '1h'),
        '4h': createBullishCandles(35, 100, '4h'),
      }, 'BTC/USDT', 550, BASE_TIME);

      const context = new StrategyContext(snapshot, 10000).freeze();
      const result = strategy.evaluate(context);

      expect(result.hasSignal).toBe(true);
      const sig = result.metadata.signal!;
      // Entry price MUST be the close of the latest finalized candle, NOT the 550 spike of the forming candle!
      expect(sig.entryPrice).toBe(latestClosed.close);
      expect(sig.entryPrice).not.toBe(formingCandle.close);
    });

    it('establishes authoritative reference time T from latest closed 5m candle', () => {
      const closed5m = createBullishCandles(35, 100, '5m');
      const latestClosed5m = closed5m[closed5m.length - 1];
      const expectedT = latestClosed5m.openTime! + CandleValidator.timeframeToMs('5m');

      const snapshot = buildMtfSnapshot({
        '5m': closed5m,
        '15m': createBullishCandles(35, 100, '15m'),
        '1h': createBullishCandles(35, 100, '1h'),
        '4h': createBullishCandles(35, 100, '4h'),
      }, 'BTC/USDT', latestClosed5m.close, BASE_TIME);

      const context = new StrategyContext(snapshot, 10000).freeze();
      const result = strategy.evaluate(context);

      expect(result.metadata.indicatorSnapshot.timestamp).toBe(expectedT);
    });

    it('projects higher timeframes strictly to closeTime <= T, ignoring higher TF forming candles', () => {
      const closed5m = createBullishCandles(35, 100, '5m');
      const closed15m = createBullishCandles(35, 100, '15m');
      const closed1h = createBullishCandles(35, 100, '1h');
      const closed4h = createBullishCandles(35, 100, '4h');

      // Add forming candles to 15m and 1h that close in the future
      const forming15m: NormalizedCandle = {
        openTime: BASE_TIME,
        timestamp: BASE_TIME,
        open: 10,
        high: 10,
        low: 5,
        close: 5,
        volume: 100,
      };

      const forming1h: NormalizedCandle = {
        openTime: BASE_TIME,
        timestamp: BASE_TIME,
        open: 10,
        high: 10,
        low: 5,
        close: 5,
        volume: 100,
      };

      const snapshot = buildMtfSnapshot({
        '5m': closed5m,
        '15m': [...closed15m, forming15m],
        '1h': [...closed1h, forming1h],
        '4h': closed4h,
      }, 'BTC/USDT', 100, BASE_TIME);

      const context = new StrategyContext(snapshot, 10000).freeze();
      const result = strategy.evaluate(context);

      // Higher timeframe forming candles must not pollute the evaluation
      expect(result.hasSignal).toBe(true);
      expect(result.metadata.signal?.type).toBe(SignalType.BUY);
    });

    it('strictly fails closed when closed candle count drops below 35 after filtering forming bar', () => {
      // Provide 35 raw candles, where the 35th is still forming (closeTime > context.timestamp)
      const raw35WithLastForming = createBullishCandles(35, 100, '5m');
      // Shift context.timestamp backwards so the last candle is unclosed
      const contextTimestamp = BASE_TIME - 300_000;

      const snapshot = buildMtfSnapshot({
        '5m': raw35WithLastForming,
        '15m': createBullishCandles(35, 100, '15m'),
        '1h': createBullishCandles(35, 100, '1h'),
        '4h': createBullishCandles(35, 100, '4h'),
      }, 'BTC/USDT', 100, contextTimestamp);

      const context = new StrategyContext(snapshot, 10000).freeze();
      const result = strategy.evaluate(context);

      // Only 34 closed candles remain at contextTimestamp -> must fail closed
      expect(result.hasSignal).toBe(false);
      expect(result.metadata.signal).toBeNull();
      expect(result.metadata.reasoning.some((r: string) => r.includes('Insufficient closed candle data'))).toBe(true);
    });
  });
});
