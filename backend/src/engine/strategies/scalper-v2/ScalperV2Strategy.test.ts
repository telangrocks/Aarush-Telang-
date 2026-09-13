import { describe, it, expect } from 'vitest';
import { ScalperV2Strategy } from './ScalperV2Strategy';
import { DEFAULT_SCALPER_CONFIG } from './ScalperV2Config';
import { StrategyContext } from '../../context/StrategyContext';
import { MarketSnapshot, NormalizedCandle } from '../../market-data/MarketSnapshot';
import { SignalType } from '../../signal';

function createBullishCandles(count = 35, basePrice = 100): NormalizedCandle[] {
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < count; i++) {
    const p = basePrice + i * 1.5;
    candles.push({
      timestamp: i * 300000,
      openTime: i * 300000,
      open: p - 1,
      high: p + 2,
      low: p - 2,
      close: p,
      volume: 1000 + i * 50
    });
  }
  return candles;
}

function createBearishCandles(count = 35, basePrice = 150): NormalizedCandle[] {
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < count; i++) {
    const p = basePrice - i * 1.5;
    candles.push({
      timestamp: i * 300000,
      openTime: i * 300000,
      open: p + 1,
      high: p + 2,
      low: p - 2,
      close: p,
      volume: 1000 + i * 50
    });
  }
  return candles;
}

function createFlatCandles(count = 35, basePrice = 100): NormalizedCandle[] {
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < count; i++) {
    candles.push({
      timestamp: i * 300000,
      openTime: i * 300000,
      open: basePrice,
      high: basePrice + 0.1,
      low: basePrice - 0.1,
      close: basePrice,
      volume: 100
    });
  }
  return candles;
}

function buildMtfSnapshot(candlesByTf: {
  '5m'?: NormalizedCandle[];
  '15m'?: NormalizedCandle[];
  '1h'?: NormalizedCandle[];
  '4h'?: NormalizedCandle[];
}, symbol = 'BTC/USDT', currentPrice?: number): MarketSnapshot {
  const latest5m = candlesByTf['5m'];
  const price = currentPrice ?? (latest5m && latest5m.length > 0 ? latest5m[latest5m.length - 1].close : 100);

  return {
    symbol,
    timestamp: 1789000000000,
    currentPrice: price,
    volume24h: 10000,
    quoteVolume24h: 10000 * price,
    metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: price + 10, lowPrice24h: price - 10 },
    candles: {
      '5m': candlesByTf['5m'] as any,
      '15m': candlesByTf['15m'] as any,
      '1h': candlesByTf['1h'] as any,
      '4h': candlesByTf['4h'] as any,
    } as any
  };
}

describe('ScalperV2Strategy — Multi-Timeframe (5m + 15m + 1h + 4h) Test Suite', () => {
  const strategy = new ScalperV2Strategy({
    ...DEFAULT_SCALPER_CONFIG,
    signalRules: {
      minConfidenceScore: 40,
      allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH']
    }
  });

  // --------------------------------------------------------------------------
  // TEST 1: Full Bullish Alignment
  // --------------------------------------------------------------------------
  it('1. Full bullish alignment: 4h LONG + 1h LONG + 15m LONG + 5m BUY -> BUY', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100),
      '15m': createBullishCandles(35, 100),
      '1h': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
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
      '5m': createBearishCandles(35, 150),
      '15m': createBearishCandles(35, 150),
      '1h': createBearishCandles(35, 150),
      '4h': createBearishCandles(35, 150),
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
      '5m': createBullishCandles(35, 100),
      '15m': createBearishCandles(35, 150), // Contradicts LONG
      '1h': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
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
      '5m': createBullishCandles(35, 100),
      '15m': createBullishCandles(35, 100),
      '1h': createBearishCandles(35, 150), // Contradicts LONG
      '4h': createBullishCandles(35, 100),
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
      '5m': createBullishCandles(35, 100),
      '15m': createBullishCandles(35, 100),
      '1h': createBullishCandles(35, 100),
      '4h': createBearishCandles(35, 150), // Contradicts LONG
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
      '5m': createBearishCandles(35, 150), // 5m generates SELL
      '15m': createBullishCandles(35, 100), // higher timeframes are LONG
      '1h': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
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
      '5m': createBullishCandles(35, 100),
      '1h': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
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
      '5m': createBullishCandles(35, 100),
      '15m': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
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
      '5m': createBullishCandles(35, 100),
      '15m': createBullishCandles(35, 100),
      '1h': createBullishCandles(35, 100),
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
      '5m': createBullishCandles(35, 100),
      '15m': createBullishCandles(34, 100), // Exactly 34 candles: under 35 requirement
      '1h': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('Insufficient candle data for timeframe 15m (got 34, required >= 35)'))).toBe(true);
  });

  it('10b. Insufficient candles boundary: 5m has 34 candles (< 35) -> NO TRADE', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(34, 100), // Exactly 34 candles: under 35 requirement
      '15m': createBullishCandles(35, 100),
      '1h': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('Insufficient candle data for timeframe 5m (got 34, required >= 35)'))).toBe(true);
  });

  it('10c. Candle depth threshold boundary: all 4 timeframes have exactly 35 candles -> eligible to proceed and qualifies BUY', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(35, 100),
      '15m': createBullishCandles(35, 100),
      '1h': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
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
      '5m': createFlatCandles(35, 100), // Weak momentum on 5m trigger
      '15m': createBullishCandles(35, 100),
      '1h': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
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
    const candles5m = createBullishCandles(35, 100);
    const snapshot = buildMtfSnapshot({
      '5m': candles5m,
      '15m': createBullishCandles(35, 100),
      '1h': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    expect(result.hasSignal).toBe(true);
    const sig = result.metadata.signal!;
    expect(sig.type).toBe(SignalType.BUY);

    const currentPrice = candles5m[candles5m.length - 1].close;
    expect(sig.entryPrice).toBe(currentPrice);

    // ATR for high-low = 4 is 4.0
    // SL = currentPrice - (4.0 * 1.5) = currentPrice - 6.0
    // TP = currentPrice + (4.0 * 2.0) = currentPrice + 8.0
    expect(sig.stopLoss).toBe(currentPrice - 6.0);
    expect(sig.takeProfit).toBe(currentPrice + 8.0);
    expect(sig.riskAssessment.riskClassification).toBe('LOW');
  });

  // --------------------------------------------------------------------------
  // PROOF OF CAUSAL RELEVANCE: EACH TIMEFRAME ALONE CHANGES OUTCOME
  // --------------------------------------------------------------------------
  describe('Proof of Causal Relevance: Each Timeframe Is Causally Active', () => {
    const baseBullish = {
      '5m': createBullishCandles(35, 100),
      '15m': createBullishCandles(35, 100),
      '1h': createBullishCandles(35, 100),
      '4h': createBullishCandles(35, 100),
    };

    it('Proof A: Changing ONLY 4h flips outcome from BUY to NO TRADE', () => {
      // 1. Base case: BUY
      const resBase = strategy.evaluate(new StrategyContext(buildMtfSnapshot(baseBullish), 10000).freeze());
      expect(resBase.hasSignal).toBe(true);
      expect(resBase.metadata.signal?.type).toBe(SignalType.BUY);

      // 2. Invert only 4h
      const snapInvert4h = buildMtfSnapshot({
        ...baseBullish,
        '4h': createBearishCandles(35, 150),
      });
      const resInvert4h = strategy.evaluate(new StrategyContext(snapInvert4h, 10000).freeze());
      expect(resInvert4h.hasSignal).toBe(false);
      expect(resInvert4h.metadata.signal).toBeNull();
    });

    it('Proof B: Changing ONLY 1h flips outcome from BUY to NO TRADE', () => {
      const snapInvert1h = buildMtfSnapshot({
        ...baseBullish,
        '1h': createBearishCandles(35, 150),
      });
      const resInvert1h = strategy.evaluate(new StrategyContext(snapInvert1h, 10000).freeze());
      expect(resInvert1h.hasSignal).toBe(false);
      expect(resInvert1h.metadata.signal).toBeNull();
    });

    it('Proof C: Changing ONLY 15m flips outcome from BUY to NO TRADE', () => {
      const snapInvert15m = buildMtfSnapshot({
        ...baseBullish,
        '15m': createBearishCandles(35, 150),
      });
      const resInvert15m = strategy.evaluate(new StrategyContext(snapInvert15m, 10000).freeze());
      expect(resInvert15m.hasSignal).toBe(false);
      expect(resInvert15m.metadata.signal).toBeNull();
    });

    it('Proof D: Changing ONLY 5m flips outcome from BUY to NO TRADE', () => {
      const snapInvert5m = buildMtfSnapshot({
        ...baseBullish,
        '5m': createFlatCandles(35, 100),
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
    const longOnlyStrategy = new ScalperV2Strategy({
      ...DEFAULT_SCALPER_CONFIG,
      signalRules: {
        minConfidenceScore: 40,
        allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH']
      }
    });
    (longOnlyStrategy as any).manifest = { ...longOnlyStrategy.manifest, supportsShort: false };

    const snapshot = buildMtfSnapshot({
      '5m': createBearishCandles(35, 150),
      '15m': createBearishCandles(35, 150),
      '1h': createBearishCandles(35, 150),
      '4h': createBearishCandles(35, 150),
    });

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = longOnlyStrategy.evaluate(context);

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('Short signal suppressed'))).toBe(true);
  });
});
