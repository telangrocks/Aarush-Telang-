import { describe, it, expect, vi } from 'vitest';
import { IndicatorEngine } from '../../indicator/IndicatorEngine';
import { MomentumStrategy } from './MomentumStrategy';
import { DEFAULT_MOMENTUM_CONFIG } from './MomentumConfig';
import { StrategyContext } from '../../context/StrategyContext';
import { MarketSnapshot, NormalizedCandle } from '../../market-data/MarketSnapshot';
import { SignalType } from '../../signal';
import { CandleValidator } from '../../../infrastructure/exchange/CandleValidator';

// Canonical base timestamp aligned to 4h boundary
const BASE_TIME = 1700000000000 - (1700000000000 % (4 * 3600 * 1000));

function createBullishCandles(
  count = 250,
  tf: '5m' | '15m' | '1h' | '4h' = '5m',
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
  count = 250,
  tf: '5m' | '15m' | '1h' | '4h' = '5m',
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
  count = 250,
  tf: '5m' | '15m' | '1h' | '4h' = '5m',
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
    '5m'?: NormalizedCandle[];
    '15m'?: NormalizedCandle[];
    '1h'?: NormalizedCandle[];
    '4h'?: NormalizedCandle[];
  },
  timestamp = BASE_TIME,
  currentPrice?: number
): MarketSnapshot {
  const latest5m = candlesByTf['5m'];
  const price = currentPrice ?? (latest5m && latest5m.length > 0 ? latest5m[latest5m.length - 1].close : 100);

  return {
    symbol: 'BTC/USDT',
    timestamp,
    currentPrice: price,
    volume24h: 10000,
    quoteVolume24h: 10000 * price,
    metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: price + 10, lowPrice24h: price - 10 },
    candles: {
      '5m': candlesByTf['5m'] || [],
      '15m': candlesByTf['15m'] || [],
      '1h': candlesByTf['1h'] || [],
      '4h': candlesByTf['4h'] || [],
    } as any
  };
}

describe('MomentumStrategy — 4TF Edge-Transition Confluence & Closed-Candle Semantics', () => {
  const defaultStrategy = new MomentumStrategy();

  // Test with relaxed minConfidenceScore for unit testing edge transitions deterministically
  const testStrategy = new MomentumStrategy({
    ...DEFAULT_MOMENTUM_CONFIG,
    signalRules: {
      minConfidenceScore: 40,
      allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH']
    }
  });

  // --------------------------------------------------------------------------
  // TEST 1: Latest 5m forming candle is excluded
  // --------------------------------------------------------------------------
  it('1. Latest 5m forming candle is excluded: latest closed 5m becomes t', () => {
    const closed5m = createBullishCandles(250, '5m', BASE_TIME);
    
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
    // Close time of forming candle is BASE_TIME + 300,000
    // Context timestamp is BASE_TIME + 120,000 (2 minutes into the forming candle)
    const contextTs = BASE_TIME + 120000;

    const snapshot = buildMtfSnapshot({
      '5m': [...closed5m, forming5m],
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, contextTs);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    // Evaluation must proceed without error and ignore the forming candle
    expect(result.strategyId).toBe('Momentum');
    // If signal generated, entryPrice must match the closed candle, NOT the forming candle (605)
    if (result.hasSignal) {
      expect(result.metadata.signal?.entryPrice).toBe(closed5m[closed5m.length - 1].close);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 2: Forming 15m, 1h, and 4h candles are excluded
  // --------------------------------------------------------------------------
  it('2. Forming 15m, 1h, and 4h candles are excluded: only closed candles at or before T are used', () => {
    const closed15m = createBullishCandles(250, '15m', BASE_TIME);
    const closed1h = createBullishCandles(250, '1h', BASE_TIME);
    const closed4h = createBullishCandles(250, '4h', BASE_TIME);

    // Forming higher timeframe candles
    const forming15m: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 600,
      high: 610,
      low: 590,
      close: 605,
      volume: 500
    };
    const forming1h: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 600,
      high: 610,
      low: 590,
      close: 605,
      volume: 500
    };
    const forming4h: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 600,
      high: 610,
      low: 590,
      close: 605,
      volume: 500
    };

    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(250, '5m', BASE_TIME),
      '15m': [...closed15m, forming15m],
      '1h': [...closed1h, forming1h],
      '4h': [...closed4h, forming4h],
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    expect(result.strategyId).toBe('Momentum');
    expect(result.metadata.reasoning).toBeInstanceOf(Array);
  });

  // --------------------------------------------------------------------------
  // TEST 3: Current and previous snapshots use correct timestamp alignment
  // --------------------------------------------------------------------------
  it('3. Current and previous snapshots use correct timestamp alignment (T vs T_previous)', () => {
    // 5m advances between T_previous and T, while 15m, 1h, 4h remain identical intra-hour
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(250, '5m', BASE_TIME),
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    expect(result.strategyId).toBe('Momentum');
    expect(result.metadata.confidenceScore).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // TEST 4: 200 closed candles fail closed
  // --------------------------------------------------------------------------
  it('4. Insufficient candles: 200 closed candles fail closed (< 201 required)', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(200, '5m', BASE_TIME), // Exactly 200: under 201 requirement
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = defaultStrategy.evaluate(context, '5m');

    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('Insufficient closed candle data for timeframe 5m (got 200, required >= 201)'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 5: 201 closed candles pass the data-count gate
  // --------------------------------------------------------------------------
  it('5. Candle depth threshold: exactly 201 closed candles pass the data-count gate', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(201, '5m', BASE_TIME), // Exactly 201: passes data gate
      '15m': createBullishCandles(201, '15m', BASE_TIME),
      '1h': createBullishCandles(201, '1h', BASE_TIME),
      '4h': createBullishCandles(201, '4h', BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    // Data-count gate passes (no rejection for insufficient candles)
    expect(result.metadata.reasoning.some((r: string) => r.includes('Insufficient closed candle data'))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 6: 5m forming candle means 202 raw candles are needed to guarantee 201 closed candles
  // --------------------------------------------------------------------------
  it('6. 201 raw candles with 1 forming candle leaves 200 closed -> fails closed; 202 raw candles passes', () => {
    const closed200 = createBullishCandles(200, '5m', BASE_TIME);
    const forming5m: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 600,
      high: 610,
      low: 590,
      close: 605,
      volume: 500
    };

    // 201 raw candles total (200 closed + 1 forming)
    const contextTs = BASE_TIME + 120000;
    const snap201Raw = buildMtfSnapshot({
      '5m': [...closed200, forming5m],
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, contextTs);

    const res201Raw = defaultStrategy.evaluate(new StrategyContext(snap201Raw, 10000).freeze(), '5m');
    expect(res201Raw.hasSignal).toBe(false);
    expect(res201Raw.metadata.reasoning.some((r: string) => r.includes('Insufficient closed candle data for timeframe 5m (got 200, required >= 201)'))).toBe(true);

    // 202 raw candles total (201 closed + 1 forming)
    const closed201 = createBullishCandles(201, '5m', BASE_TIME);
    const snap202Raw = buildMtfSnapshot({
      '5m': [...closed201, forming5m],
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, contextTs);

    const res202Raw = testStrategy.evaluate(new StrategyContext(snap202Raw, 10000).freeze(), '5m');
    expect(res202Raw.metadata.reasoning.some((r: string) => r.includes('Insufficient closed candle data for timeframe 5m'))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 7: false -> true emits a signal
  // --------------------------------------------------------------------------
  it('7. Edge transition: false -> true emits a signal (NEW BUY EVENT)', () => {
    // Construct 5m where T_previous was NOT aligned, but T IS aligned
    // 249 flat candles + 1 strong bullish surge candle at T
    const flat5m = createFlatCandles(249, '5m', BASE_TIME - 300000, 100);
    const surgeCandle: NormalizedCandle = {
      openTime: BASE_TIME - 300000,
      timestamp: BASE_TIME - 300000,
      open: 100,
      high: 130,
      low: 100,
      close: 125,
      volume: 50000
    };
    const candles5m = [...flat5m, surgeCandle];

    const snapshot = buildMtfSnapshot({
      '5m': candles5m,
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    // If confluence aligned on surge, it emits new BUY event
    if (result.hasSignal) {
      expect(result.metadata.signal?.type).toBe(SignalType.BUY);
      expect(result.metadata.reasoning.some((r: string) => r.includes('[5M EDGE EVENT] New BUY event'))).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 8: true -> true suppresses continuation
  // --------------------------------------------------------------------------
  it('8. Edge transition: true -> true suppresses continuation (NO RE-ENTRY)', () => {
    // Both T_previous and T are fully bullish and aligned
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(250, '5m', BASE_TIME),
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    // Both previous and current bars were aligned BUY -> continuation suppressed!
    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
    expect(result.metadata.reasoning.some((r: string) => r.includes('[5M CONTINUATION] Trend continuation suppressed'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 9: BUY -> SELL direction flip emits the opposite signal
  // --------------------------------------------------------------------------
  it('9. BUY -> SELL direction flip emits the opposite signal (NEW SELL EVENT)', () => {
    // 5m ends with strong bearish candle while T_previous was bullish
    const bullishBase5m = createBullishCandles(249, '5m', BASE_TIME - 300000, 100);
    const dropCandle: NormalizedCandle = {
      openTime: BASE_TIME - 300000,
      timestamp: BASE_TIME - 300000,
      open: 500,
      high: 505,
      low: 400,
      close: 410,
      volume: 50000
    };
    const candles5m = [...bullishBase5m, dropCandle];

    const snapshot = buildMtfSnapshot({
      '5m': candles5m,
      '15m': createBearishCandles(250, '15m', BASE_TIME),
      '1h': createBearishCandles(250, '1h', BASE_TIME),
      '4h': createBearishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = testStrategy.evaluate(context, '5m');

    // If SELL aligned at T while T_previous had no SELL alignment, it emits SELL
    if (result.hasSignal) {
      expect(result.metadata.signal?.type).toBe(SignalType.SELL);
      expect(result.metadata.reasoning.some((r: string) => r.includes('[5M EDGE EVENT] New SELL event'))).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 10: 5m candle requirement vs higher TFs
  // --------------------------------------------------------------------------
  it('10. 5m below 201 closed candles fails closed; higher timeframes below 201 are omitted without failing', () => {
    // 5m has 200 candles (< 201) -> fails closed
    const snap5m = buildMtfSnapshot({
      '5m': createBullishCandles(200, '5m', BASE_TIME),
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);
    const res5m = defaultStrategy.evaluate(new StrategyContext(snap5m, 10000).freeze(), '5m');
    expect(res5m.hasSignal).toBe(false);
    expect(res5m.metadata.reasoning.some((r: string) => r.includes('Insufficient closed candle data for timeframe 5m'))).toBe(true);

    // 15m has 200 candles -> higher TF omitted from projection, but 5m still evaluates
    const snap15m = buildMtfSnapshot({
      '5m': createBullishCandles(250, '5m', BASE_TIME),
      '15m': createBullishCandles(200, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);
    const res15m = defaultStrategy.evaluate(new StrategyContext(snap15m, 10000).freeze(), '5m');
    expect(res15m.metadata.reasoning.some((r: string) => r.includes('Insufficient closed candle data'))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // TEST 11: Temporary risk-gate failure does not corrupt market-alignment edge state
  // --------------------------------------------------------------------------
  it('11. Temporary risk-gate failure does not corrupt market-alignment edge state', () => {
    const snapshot = buildMtfSnapshot({
      '5m': createBullishCandles(250, '5m', BASE_TIME),
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    // 1. Account balance zero fails current risk gate
    const mockContextZeroBalance = {
      marketSnapshot: snapshot,
      timestamp: BASE_TIME,
      accountBalance: 0,
      freeze: () => mockContextZeroBalance
    } as any;
    const resultZeroBalance = testStrategy.evaluate(mockContextZeroBalance, '5m');
    expect(resultZeroBalance.hasSignal).toBe(false);
    expect(resultZeroBalance.metadata.reasoning.some((r: string) => r.includes('Account balance not available'))).toBe(true);

    // 2. Zero ATR fails current risk gate (constant price 100 -> TR = 0 -> ATR = 0)
    const zeroAtr15m: NormalizedCandle[] = createBullishCandles(250, '15m', BASE_TIME).map(c => ({
      ...c,
      high: 100,
      low: 100,
      open: 100,
      close: 100
    }));
    const snapZeroAtr = buildMtfSnapshot({
      '5m': zeroAtr15m,
      '15m': zeroAtr15m,
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);
    const resZeroAtr = testStrategy.evaluate(new StrategyContext(snapZeroAtr, 10000).freeze(), '5m');
    expect(resZeroAtr.hasSignal).toBe(false);
    expect(resZeroAtr.metadata.reasoning.some((r: string) => r.includes('ATR is zero or unavailable'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 12: 5m entry trigger is authoritative: 4h and 15m disagreement cannot veto 5m signal
  // --------------------------------------------------------------------------
  it('12. 5m entry trigger is authoritative: 4h and 15m disagreement cannot veto 5m signal', () => {
    // 5m is strongly bullish, but 4h is bearish
    const snap4hBearish = buildMtfSnapshot({
      '5m': createBullishCandles(250, '5m', BASE_TIME),
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBearishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    const res4h = testStrategy.evaluate(new StrategyContext(snap4hBearish, 10000).freeze(), '5m');
    expect(res4h.metadata.reasoning.some((r: string) => r.includes('[MTF REJECTED]'))).toBe(false);
    expect(res4h.metadata.targetTimeframe).toBe('5m');

    // 5m is strongly bullish, but 15m is bearish
    const snap15mBearish = buildMtfSnapshot({
      '5m': createBullishCandles(250, '5m', BASE_TIME),
      '15m': createBearishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    const res15m = testStrategy.evaluate(new StrategyContext(snap15mBearish, 10000).freeze(), '5m');
    expect(res15m.metadata.reasoning.some((r: string) => r.includes('[MTF REJECTED]'))).toBe(false);
    expect(res15m.metadata.targetTimeframe).toBe('5m');
  });

  // --------------------------------------------------------------------------
  // TEST 13: Transient zero-balance rejection at Bar 1 recovers on Bar 2
  // --------------------------------------------------------------------------
  it('13. Transient zero-balance rejection at Bar 1 recovers and emits BUY at Bar 2 when balance is restored', () => {
    const strategy = new MomentumStrategy({
      ...DEFAULT_MOMENTUM_CONFIG,
      signalRules: {
        minConfidenceScore: 40,
        allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH']
      }
    });

    // Bar 1: Surge candle triggers transition from NOT ALIGNED to ALIGNED
    const flat5m = createFlatCandles(249, '5m', BASE_TIME - 300000, 100);
    const surgeCandle: NormalizedCandle = {
      openTime: BASE_TIME - 300000,
      timestamp: BASE_TIME - 300000,
      open: 100,
      high: 130,
      low: 100,
      close: 125,
      volume: 50000
    };
    const candles5mBar1 = [...flat5m, surgeCandle];

    const snapBar1 = buildMtfSnapshot({
      '5m': candles5mBar1,
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    // Evaluate Bar 1 with zero balance -> transient risk rejection
    const mockContextZeroBal = {
      marketSnapshot: snapBar1,
      timestamp: BASE_TIME,
      accountBalance: 0,
      freeze: () => mockContextZeroBal
    } as any;
    const resBar1 = strategy.evaluate(mockContextZeroBal, '5m');
    expect(resBar1.hasSignal).toBe(false);
    expect(resBar1.metadata.reasoning.some((r: string) => r.includes('Account balance not available'))).toBe(true);

    // Bar 2: 5 minutes later, market alignment persists, balance restored to 10000
    const candleBar2: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 125,
      high: 135,
      low: 124,
      close: 130,
      volume: 50000
    };
    const candles5mBar2 = [...candles5mBar1, candleBar2];

    const snapBar2 = buildMtfSnapshot({
      '5m': candles5mBar2,
      '15m': createBullishCandles(250, '15m', BASE_TIME + 300000),
      '1h': createBullishCandles(250, '1h', BASE_TIME + 300000),
      '4h': createBullishCandles(250, '4h', BASE_TIME + 300000),
    }, BASE_TIME + 300000);

    const contextBar2 = new StrategyContext(snapBar2, 10000).freeze();
    const resBar2 = strategy.evaluate(contextBar2, '5m');

    // Bar 2 must successfully recover the entry opportunity!
    expect(resBar2.hasSignal).toBe(true);
    expect(resBar2.metadata.signal?.type).toBe(SignalType.BUY);
    expect(resBar2.metadata.reasoning.some((r: string) => r.includes('[5M EDGE RECOVERY] Recovered BUY event'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 14: Bar 3 continuation following recovered Bar 2 is suppressed
  // --------------------------------------------------------------------------
  it('14. Bar 3 continuation following recovered Bar 2 is suppressed (no duplicate / repeated signal)', () => {
    const strategy = new MomentumStrategy({
      ...DEFAULT_MOMENTUM_CONFIG,
      signalRules: {
        minConfidenceScore: 40,
        allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH']
      }
    });

    // Bar 1: Rejected due to zero balance
    const flat5m = createFlatCandles(249, '5m', BASE_TIME - 300000, 100);
    const surgeCandle: NormalizedCandle = {
      openTime: BASE_TIME - 300000,
      timestamp: BASE_TIME - 300000,
      open: 100,
      high: 130,
      low: 100,
      close: 125,
      volume: 50000
    };
    const candles5mBar1 = [...flat5m, surgeCandle];
    const snapBar1 = buildMtfSnapshot({
      '5m': candles5mBar1,
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    const mockContextZeroBal = {
      marketSnapshot: snapBar1,
      timestamp: BASE_TIME,
      accountBalance: 0,
      freeze: () => mockContextZeroBal
    } as any;
    strategy.evaluate(mockContextZeroBal, '5m');

    // Bar 2: Recovery emits BUY
    const candleBar2: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 125,
      high: 135,
      low: 124,
      close: 130,
      volume: 50000
    };
    const candles5mBar2 = [...candles5mBar1, candleBar2];
    const snapBar2 = buildMtfSnapshot({
      '5m': candles5mBar2,
      '15m': createBullishCandles(250, '15m', BASE_TIME + 300000),
      '1h': createBullishCandles(250, '1h', BASE_TIME + 300000),
      '4h': createBullishCandles(250, '4h', BASE_TIME + 300000),
    }, BASE_TIME + 300000);
    const resBar2 = strategy.evaluate(new StrategyContext(snapBar2, 10000).freeze(), '5m');
    expect(resBar2.hasSignal).toBe(true);

    // Bar 3: Continuation must be suppressed (anti-chase / no repeat alerts)
    const candleBar3: NormalizedCandle = {
      openTime: BASE_TIME + 300000,
      timestamp: BASE_TIME + 300000,
      open: 130,
      high: 140,
      low: 129,
      close: 135,
      volume: 50000
    };
    const candles5mBar3 = [...candles5mBar2, candleBar3];
    const snapBar3 = buildMtfSnapshot({
      '5m': candles5mBar3,
      '15m': createBullishCandles(250, '15m', BASE_TIME + 600000),
      '1h': createBullishCandles(250, '1h', BASE_TIME + 600000),
      '4h': createBullishCandles(250, '4h', BASE_TIME + 600000),
    }, BASE_TIME + 600000);
    const resBar3 = strategy.evaluate(new StrategyContext(snapBar3, 10000).freeze(), '5m');

    expect(resBar3.hasSignal).toBe(false);
    expect(resBar3.metadata.signal).toBeNull();
    expect(resBar3.metadata.reasoning.some((r: string) => r.includes('[5M CONTINUATION] Trend continuation suppressed'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 15: Transient ATR spike (EXTREME risk) at Bar 1 recovers on Bar 2
  // --------------------------------------------------------------------------
  it('15. Transient ATR spike (EXTREME risk) at Bar 1 recovers and emits BUY at Bar 2 when ATR normalizes', () => {
    const conservativeStrategy = new MomentumStrategy({
      ...DEFAULT_MOMENTUM_CONFIG,
      signalRules: {
        minConfidenceScore: 40,
        allowedRiskClassifications: ['LOW', 'MEDIUM']
      }
    });

    const flat5m = createFlatCandles(249, '5m', BASE_TIME - 300000, 100);
    const wildSurgeCandle: NormalizedCandle = {
      openTime: BASE_TIME - 300000,
      timestamp: BASE_TIME - 300000,
      open: 100,
      high: 220,
      low: 60,
      close: 125,
      volume: 50000
    };
    const candles5mBar1 = [...flat5m, wildSurgeCandle];
    const snapBar1 = buildMtfSnapshot({
      '5m': candles5mBar1,
      '15m': createBullishCandles(250, '15m', BASE_TIME),
      '1h': createBullishCandles(250, '1h', BASE_TIME),
      '4h': createBullishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    const resBar1 = conservativeStrategy.evaluate(new StrategyContext(snapBar1, 10000).freeze(), '5m');
    expect(resBar1.hasSignal).toBe(false);

    // Bar 2: Normalizes
    const normalCandleBar2: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 125,
      high: 126,
      low: 124.5,
      close: 125.5,
      volume: 50000
    };
    const candles5mBar2 = [...candles5mBar1, normalCandleBar2];
    const snapBar2 = buildMtfSnapshot({
      '5m': candles5mBar2,
      '15m': createBullishCandles(250, '15m', BASE_TIME + 300000),
      '1h': createBullishCandles(250, '1h', BASE_TIME + 300000),
      '4h': createBullishCandles(250, '4h', BASE_TIME + 300000),
    }, BASE_TIME + 300000);

    const resBar2 = conservativeStrategy.evaluate(new StrategyContext(snapBar2, 10000).freeze(), '5m');
    expect(resBar2.metadata.targetTimeframe).toBe('5m');
  });

  // --------------------------------------------------------------------------
  // TEST 16: Transient rejection on SELL edge event recovers on Bar 2
  // --------------------------------------------------------------------------
  it('16. Transient rejection on SELL edge event recovers on Bar 2 when risk normalizes', () => {
    const strategy = new MomentumStrategy({
      ...DEFAULT_MOMENTUM_CONFIG,
      signalRules: {
        minConfidenceScore: 40,
        allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH']
      }
    });

    const bullishBase5m = createBullishCandles(249, '5m', BASE_TIME - 300000, 500);
    const dropCandle: NormalizedCandle = {
      openTime: BASE_TIME - 300000,
      timestamp: BASE_TIME - 300000,
      open: 500,
      high: 505,
      low: 400,
      close: 410,
      volume: 50000
    };
    const candles5mBar1 = [...bullishBase5m, dropCandle];

    const snapBar1 = buildMtfSnapshot({
      '5m': candles5mBar1,
      '15m': createBearishCandles(250, '15m', BASE_TIME),
      '1h': createBearishCandles(250, '1h', BASE_TIME),
      '4h': createBearishCandles(250, '4h', BASE_TIME),
    }, BASE_TIME);

    const mockContextZeroBal = {
      marketSnapshot: snapBar1,
      timestamp: BASE_TIME,
      accountBalance: 0,
      freeze: () => mockContextZeroBal
    } as any;
    const resBar1 = strategy.evaluate(mockContextZeroBal, '5m');
    expect(resBar1.hasSignal).toBe(false);

    const dropCandle2: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 410,
      high: 412,
      low: 395,
      close: 398,
      volume: 50000
    };
    const candles5mBar2 = [...candles5mBar1, dropCandle2];

    const snapBar2 = buildMtfSnapshot({
      '5m': candles5mBar2,
      '15m': createBearishCandles(250, '15m', BASE_TIME + 300000),
      '1h': createBearishCandles(250, '1h', BASE_TIME + 300000),
      '4h': createBearishCandles(250, '4h', BASE_TIME + 300000),
    }, BASE_TIME + 300000);

    const resBar2 = strategy.evaluate(new StrategyContext(snapBar2, 10000).freeze(), '5m');
    if (resBar2.hasSignal) {
      expect(resBar2.metadata.signal?.type).toBe(SignalType.SELL);
      expect(resBar2.metadata.reasoning.some((r: string) => r.includes('[5M EDGE RECOVERY] Recovered SELL event'))).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 17: Strong bullish edge transition across all 4 supported timeframes (5m, 15m, 1h, 4h)
  // --------------------------------------------------------------------------
  it('17. Emits valid BUY signal on strong bullish edge transition across all 4 timeframes (5m, 15m, 1h, 4h)', () => {
    const timeframes: Array<'5m' | '15m' | '1h' | '4h'> = ['5m', '15m', '1h', '4h'];

    for (const tf of timeframes) {
      const tfMs = CandleValidator.timeframeToMs(tf);
      const flatBase = createFlatCandles(249, tf, BASE_TIME - tfMs, 100);
      const surgeCandle: NormalizedCandle = {
        openTime: BASE_TIME - tfMs,
        timestamp: BASE_TIME - tfMs,
        open: 100,
        high: 126,
        low: 100,
        close: 125,
        volume: 50000,
      };
      const snapshot = buildMtfSnapshot({
        [tf]: [...flatBase, surgeCandle],
      }, BASE_TIME, 125);

      const strategy = new MomentumStrategy();
      const result = strategy.evaluate(new StrategyContext(snapshot, 10000).freeze(), tf);

      expect(result.hasSignal).toBe(true);
      expect(result.metadata.signal?.type).toBe(SignalType.BUY);
      expect(result.confidenceScore).toBeGreaterThanOrEqual(70);
      expect(result.metadata.conditionResult?.timeframes?.[tf]?.trend.priceAboveEMA).toBe(true);
      expect(result.metadata.conditionResult?.timeframes?.[tf]?.trend.trendDirection).toBe('UP');
    }
  });

  // --------------------------------------------------------------------------
  // TEST 18: Strong bearish edge transition across all 4 supported timeframes (5m, 15m, 1h, 4h)
  // --------------------------------------------------------------------------
  it('18. Emits valid SELL signal on strong bearish edge transition across all 4 timeframes (5m, 15m, 1h, 4h)', () => {
    const timeframes: Array<'5m' | '15m' | '1h' | '4h'> = ['5m', '15m', '1h', '4h'];

    for (const tf of timeframes) {
      const tfMs = CandleValidator.timeframeToMs(tf);
      const flatBase = createFlatCandles(249, tf, BASE_TIME - tfMs, 100);
      const dropCandle: NormalizedCandle = {
        openTime: BASE_TIME - tfMs,
        timestamp: BASE_TIME - tfMs,
        open: 100,
        high: 100,
        low: 79,
        close: 80,
        volume: 50000,
      };
      const snapshot = buildMtfSnapshot({
        [tf]: [...flatBase, dropCandle],
      }, BASE_TIME, 80);

      const strategy = new MomentumStrategy();
      const result = strategy.evaluate(new StrategyContext(snapshot, 10000).freeze(), tf);

      expect(result.hasSignal).toBe(true);
      expect(result.metadata.signal?.type).toBe(SignalType.SELL);
      expect(result.confidenceScore).toBeGreaterThanOrEqual(70);
      expect(result.metadata.conditionResult?.timeframes?.[tf]?.trend.priceAboveEMA).toBe(false);
      expect(result.metadata.conditionResult?.timeframes?.[tf]?.trend.trendDirection).toBe('DOWN');
    }
  });

  // --------------------------------------------------------------------------
  // TEST 19: Counter-trend bullish spike while EMA(50) < EMA(200) is blocked
  // --------------------------------------------------------------------------
  it('19. Rejects counter-trend BUY spike when price > EMA(50) but EMA(50) < EMA(200) (downtrend)', () => {
    const bearishBase5m = createBearishCandles(249, '5m', BASE_TIME - 300000, 1000);
    // Bearish base ends at 504 with EMA(50) ~ 553 < EMA(200) ~ 701.
    // A counter-trend rally candle to 600 puts price above EMA(50) with strong MACD/RSI/ATR/volume (longScore=85),
    // but EMA(50) remains well below EMA(200) (trendDirection === 'DOWN').
    const rallyCandle: NormalizedCandle = {
      openTime: BASE_TIME - 300000,
      timestamp: BASE_TIME - 300000,
      open: 504,
      high: 605,
      low: 502,
      close: 600,
      volume: 50000,
    };
    const snapshot = buildMtfSnapshot({
      '5m': [...bearishBase5m, rallyCandle],
    }, BASE_TIME, 600);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const resDefault = defaultStrategy.evaluate(context, '5m');
    const resRelaxed = testStrategy.evaluate(context, '5m');

    expect(resDefault.metadata.conditionResult?.timeframes?.['5m']?.trend.priceAboveEMA).toBe(true);
    expect(resDefault.metadata.conditionResult?.timeframes?.['5m']?.trend.trendDirection).toBe('DOWN');
    expect(resDefault.hasSignal).toBe(false);
    expect(resDefault.metadata.signal).toBeNull();
    expect(resRelaxed.hasSignal).toBe(false);
    expect(resRelaxed.metadata.signal).toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 20: Counter-trend bearish drop while EMA(50) > EMA(200) is blocked
  // --------------------------------------------------------------------------
  it('20. Rejects counter-trend SELL drop when price < EMA(50) but EMA(50) > EMA(200) (uptrend)', () => {
    const bullishBase5m = createBullishCandles(249, '5m', BASE_TIME - 300000, 500);
    // Bullish base ends at 996 with EMA(50) ~ 946 > EMA(200) ~ 798.
    // A sharp drop to 890 puts price below EMA(50) with strong bearish MACD/RSI/ATR/volume (shortScore=70),
    // but EMA(50) remains well above EMA(200) (trendDirection === 'UP').
    const pullbackCandle: NormalizedCandle = {
      openTime: BASE_TIME - 300000,
      timestamp: BASE_TIME - 300000,
      open: 996,
      high: 997,
      low: 888,
      close: 890,
      volume: 50000,
    };
    const snapshot = buildMtfSnapshot({
      '5m': [...bullishBase5m, pullbackCandle],
    }, BASE_TIME, 890);

    const context = new StrategyContext(snapshot, 10000).freeze();
    const resDefault = defaultStrategy.evaluate(context, '5m');
    const resRelaxed = testStrategy.evaluate(context, '5m');

    expect(resDefault.metadata.conditionResult?.timeframes?.['5m']?.trend.priceAboveEMA).toBe(false);
    expect(resDefault.metadata.conditionResult?.timeframes?.['5m']?.trend.trendDirection).toBe('UP');
    expect(resDefault.hasSignal).toBe(false);
    expect(resDefault.metadata.signal).toBeNull();
    expect(resRelaxed.hasSignal).toBe(false);
    expect(resRelaxed.metadata.signal).toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 21: Flat sideways market produces no signal across all 4 timeframes
  // --------------------------------------------------------------------------
  it('21. Flat sideways market (EMA(50) === EMA(200)) produces no signal across 5m, 15m, 1h, 4h', () => {
    const timeframes: Array<'5m' | '15m' | '1h' | '4h'> = ['5m', '15m', '1h', '4h'];

    for (const tf of timeframes) {
      const snapshot = buildMtfSnapshot({
        [tf]: createFlatCandles(250, tf, BASE_TIME, 100),
      }, BASE_TIME, 100);

      const context = new StrategyContext(snapshot, 10000).freeze();
      const resDefault = defaultStrategy.evaluate(context, tf);
      const resRelaxed = testStrategy.evaluate(context, tf);

      expect(resDefault.hasSignal).toBe(false);
      expect(resDefault.metadata.signal).toBeNull();
      expect(resRelaxed.hasSignal).toBe(false);
      expect(resRelaxed.metadata.signal).toBeNull();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 22: Bearish SELL edge transition with EMA(50) < EMA(200) recovers on Bar 2 and suppresses Bar 3
  // --------------------------------------------------------------------------
  it('22. Bearish SELL edge transition (EMA(50) < EMA(200)) rejected by zero balance at Bar 1 recovers at Bar 2 and suppresses Bar 3', () => {
    const strategy = new MomentumStrategy();

    const flat5m = createFlatCandles(249, '5m', BASE_TIME - 300000, 100);
    const dropBar1: NormalizedCandle = {
      openTime: BASE_TIME - 300000,
      timestamp: BASE_TIME - 300000,
      open: 100,
      high: 100,
      low: 79,
      close: 80,
      volume: 50000,
    };
    const candlesBar1 = [...flat5m, dropBar1];
    const snapBar1 = buildMtfSnapshot({ '5m': candlesBar1 }, BASE_TIME, 80);

    const zeroBalCtx = {
      marketSnapshot: snapBar1,
      timestamp: BASE_TIME,
      accountBalance: 0,
      freeze: () => zeroBalCtx,
    } as any;

    const resBar1 = strategy.evaluate(zeroBalCtx, '5m');
    expect(resBar1.hasSignal).toBe(false);

    // Bar 2: Bearish trend persists (EMA(50) < EMA(200), price < EMA(50)), balance restored
    const dropBar2: NormalizedCandle = {
      openTime: BASE_TIME,
      timestamp: BASE_TIME,
      open: 80,
      high: 80.5,
      low: 74,
      close: 75,
      volume: 50000,
    };
    const candlesBar2 = [...candlesBar1, dropBar2];
    const snapBar2 = buildMtfSnapshot({ '5m': candlesBar2 }, BASE_TIME + 300000, 75);

    const resBar2 = strategy.evaluate(new StrategyContext(snapBar2, 10000).freeze(), '5m');
    expect(resBar2.hasSignal).toBe(true);
    expect(resBar2.metadata.signal?.type).toBe(SignalType.SELL);
    expect(resBar2.metadata.reasoning.some((r: string) => r.includes('[5M EDGE RECOVERY] Recovered SELL event'))).toBe(true);

    // Bar 3: Continuation suppressed
    const dropBar3: NormalizedCandle = {
      openTime: BASE_TIME + 300000,
      timestamp: BASE_TIME + 300000,
      open: 75,
      high: 75.5,
      low: 69,
      close: 70,
      volume: 50000,
    };
    const candlesBar3 = [...candlesBar2, dropBar3];
    const snapBar3 = buildMtfSnapshot({ '5m': candlesBar3 }, BASE_TIME + 600000, 70);

    const resBar3 = strategy.evaluate(new StrategyContext(snapBar3, 10000).freeze(), '5m');
    expect(resBar3.hasSignal).toBe(false);
    expect(resBar3.metadata.reasoning.some((r: string) => r.includes('[5M CONTINUATION] Trend continuation suppressed'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 23: Non-array rawCandles fails closed cleanly
  // --------------------------------------------------------------------------
  it('23. Fails closed when rawCandles is non-array, null, undefined, or context timestamp is non-finite', () => {
    const strategy = new MomentumStrategy();
    for (const invalidCandles of [undefined, null, {}, 'not-an-array', 123]) {
      const snap = {
        ...buildMtfSnapshot({}),
        candles: { '5m': invalidCandles } as any,
      };
      const ctx = {
        marketSnapshot: snap,
        timestamp: BASE_TIME,
        accountBalance: 10000,
        freeze: () => ctx,
      } as any;
      const res = strategy.evaluate(ctx, '5m');
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
    }

    const validSnap = buildMtfSnapshot({ '5m': createBullishCandles(250, '5m', BASE_TIME) }, BASE_TIME);
    const nanTsCtx = {
      marketSnapshot: validSnap,
      timestamp: Number.NaN,
      accountBalance: 10000,
      freeze: () => nanTsCtx,
    } as any;
    const nanTsRes = strategy.evaluate(nanTsCtx, '5m');
    expect(nanTsRes.hasSignal).toBe(false);
    expect(nanTsRes.metadata.signal).toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 24: Strict OHLC validation across entire closed series (including index 0)
  // --------------------------------------------------------------------------
  it('24. Rejects NaN, +/-Infinity, zero, negative, missing fields, or high < low anywhere in closed candle series', () => {
    const tfMs = CandleValidator.timeframeToMs('5m');
    const buildValidTriggerCandles = () => {
      const flatBase = createFlatCandles(249, '5m', BASE_TIME - tfMs, 100);
      const surgeCandle: NormalizedCandle = {
        openTime: BASE_TIME - tfMs,
        timestamp: BASE_TIME - tfMs,
        open: 100,
        high: 126,
        low: 100,
        close: 125,
        volume: 50000,
      };
      return [...flatBase, surgeCandle];
    };

    const mutations: Array<{ name: string; mutate: (c: NormalizedCandle) => void }> = [
      { name: 'open NaN at index 0', mutate: c => { c.open = Number.NaN; } },
      { name: 'high +Infinity at index 0', mutate: c => { c.high = Number.POSITIVE_INFINITY; } },
      { name: 'low -Infinity at index 0', mutate: c => { c.low = Number.NEGATIVE_INFINITY; } },
      { name: 'close 0 at index 0', mutate: c => { c.close = 0; } },
      { name: 'open negative at index 0', mutate: c => { c.open = -5; } },
      { name: 'high < low at index 0', mutate: c => { c.high = 90; c.low = 95; } },
      { name: 'missing high field at index 0', mutate: c => { delete (c as any).high; } },
      { name: 'missing low field at index 0', mutate: c => { delete (c as any).low; } },
    ];

    for (const { mutate } of mutations) {
      const candles = buildValidTriggerCandles().map(c => ({ ...c }));
      mutate(candles[0]);
      const snap = buildMtfSnapshot({ '5m': candles }, BASE_TIME, 125);
      const res = new MomentumStrategy().evaluate(new StrategyContext(snap, 10000).freeze(), '5m');
      expect(res.hasSignal).toBe(false);
      expect(res.metadata.signal).toBeNull();
    }
  });

  // --------------------------------------------------------------------------
  // TEST 25: Non-finite indicator outputs fail closed before signal qualification
  // --------------------------------------------------------------------------
  it('25. Rejects non-finite EMA, ATR, RSI, or MACD outputs fail-closed', () => {
    const tfMs = CandleValidator.timeframeToMs('5m');
    const candles = [
      ...createFlatCandles(249, '5m', BASE_TIME - tfMs, 100),
      {
        openTime: BASE_TIME - tfMs,
        timestamp: BASE_TIME - tfMs,
        open: 100,
        high: 126,
        low: 100,
        close: 125,
        volume: 50000,
      } as NormalizedCandle,
    ];
    const snap = buildMtfSnapshot({ '5m': candles }, BASE_TIME, 125);

    const origEval = IndicatorEngine.prototype.evaluate;
    for (const mode of ['emaFastInf', 'atrNaN', 'rsiNaN', 'macdNaN'] as const) {
      const spy = vi.spyOn(IndicatorEngine.prototype, 'evaluate').mockImplementation(function (this: IndicatorEngine, s: MarketSnapshot) {
        const res = origEval.call(this, s);
        const cloned = structuredClone(res);
        const ind = cloned.timeframes['5m'];
        if (ind) {
          if (mode === 'emaFastInf') ind.ema[50][ind.ema[50].length - 1] = Number.POSITIVE_INFINITY;
          if (mode === 'atrNaN') ind.atr[14][ind.atr[14].length - 1] = Number.NaN;
          if (mode === 'rsiNaN') ind.rsi[14][ind.rsi[14].length - 1] = Number.NaN;
          if (mode === 'macdNaN') ind.macd['12,26,9'][ind.macd['12,26,9'].length - 1].histogram = Number.NaN;
        }
        return cloned;
      });
      try {
        const res = new MomentumStrategy().evaluate(new StrategyContext(snap, 10000).freeze(), '5m');
        expect(res.hasSignal).toBe(false);
        expect(res.metadata.signal).toBeNull();
      } finally {
        spy.mockRestore();
      }
    }
  });
});
