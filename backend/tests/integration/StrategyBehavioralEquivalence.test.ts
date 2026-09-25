import { describe, it, expect, vi } from 'vitest';
import { ScalperV2Strategy } from '../../src/engine/strategies/scalper-v2/ScalperV2Strategy';
import { MomentumStrategy } from '../../src/engine/strategies/momentum/MomentumStrategy';
import { BreakoutStrategy } from '../../src/engine/strategies/breakout/BreakoutStrategy';
import { MeanReversionStrategy } from '../../src/engine/strategies/mean-reversion/MeanReversionStrategy';
import { VWAPStrategy } from '../../src/engine/strategies/vwap/VWAPStrategy';
import { StrategyContext } from '../../src/engine/context/StrategyContext';
import { MarketSnapshot, NormalizedCandle } from '../../src/engine/market-data/MarketSnapshot';
import { MatrixEvaluator } from '../../src/engine/matrix/MatrixEvaluator';
import { MultiTimeframeCandleStore, StoredCandleSeries } from '../../src/engine/scanner/MultiTimeframeCandleStore';

function generateCandles(count: number, basePrice: number = 100): NormalizedCandle[] {
  const startTs = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => {
    const ts = startTs + i * 60_000;
    const wave = Math.sin(i * 0.1) * 2;
    return {
      timestamp: ts,
      openTime: ts,
      open: basePrice + wave,
      high: basePrice + wave + 1,
      low: basePrice + wave - 1,
      close: basePrice + wave + 0.5,
      volume: 1000 + i * 10,
    };
  });
}

function createMarketSnapshotPair(symbol: string = 'BTCUSDT'): {
  legacySnapshot: MarketSnapshot;
  mtfSnapshot: MarketSnapshot;
} {
  const candles5m = generateCandles(100, 100);
  const candles15m = generateCandles(250, 100);
  const candles1h = generateCandles(250, 100);
  const candles4h = generateCandles(250, 100);
  const currentPrice = candles15m[candles15m.length - 1].close;

  const legacySnapshot: MarketSnapshot = {
    symbol,
    timestamp: 1_700_000_000_000,
    currentPrice,
    volume24h: 10000,
    quoteVolume24h: 10000 * currentPrice,
    candles: {
      '1m': [],
      '3m': [],
      '5m': candles5m,
      '15m': candles15m,
      '30m': [],
      '1h': [],
      '4h': [],
    },
    metadata: {
      priceChange24h: 0,
      priceChangePercent24h: 0,
      highPrice24h: 105,
      lowPrice24h: 95,
    },
  };

  const mtfSnapshot: MarketSnapshot = {
    symbol,
    timestamp: 1_700_000_000_000,
    currentPrice,
    volume24h: 10000,
    quoteVolume24h: 10000 * currentPrice,
    candles: {
      '1m': [],
      '3m': [],
      '5m': candles5m,
      '15m': candles15m,
      '30m': [],
      '1h': candles1h,
      '4h': candles4h,
    },
    metadata: {
      priceChange24h: 0,
      priceChangePercent24h: 0,
      highPrice24h: 105,
      lowPrice24h: 95,
    },
  };

  return { legacySnapshot, mtfSnapshot };
}

describe('Suite 5: Behavioral Equivalence (StrategyBehavioralEquivalence)', () => {
  it('test_scalper_behavioral_equivalence: Asserts ScalperV2 parity between legacy and MTF snapshots', () => {
    const strategy = new ScalperV2Strategy();
    const { legacySnapshot, mtfSnapshot } = createMarketSnapshotPair();

    const legacyContext = new StrategyContext(legacySnapshot, 1000);
    const mtfContext = new StrategyContext(mtfSnapshot, 1000);

    const legacyRes = strategy.evaluate(legacyContext);
    const mtfRes = strategy.evaluate(mtfContext);

    expect(mtfRes.hasSignal).toBe(legacyRes.hasSignal);
    expect(mtfRes.confidenceScore).toBe(legacyRes.confidenceScore);
    expect(mtfRes.strategyId).toBe(legacyRes.strategyId);
  });

  it('test_momentum_behavioral_equivalence: Asserts Momentum parity between legacy and MTF snapshots', () => {
    const strategy = new MomentumStrategy();
    const { legacySnapshot, mtfSnapshot } = createMarketSnapshotPair();

    const legacyContext = new StrategyContext(legacySnapshot, 1000);
    const mtfContext = new StrategyContext(mtfSnapshot, 1000);

    const legacyRes = strategy.evaluate(legacyContext);
    const mtfRes = strategy.evaluate(mtfContext);

    expect(mtfRes.hasSignal).toBe(legacyRes.hasSignal);
    expect(mtfRes.confidenceScore).toBe(legacyRes.confidenceScore);
  });

  it('test_breakout_behavioral_equivalence: Asserts Breakout parity between legacy and MTF snapshots', () => {
    const strategy = new BreakoutStrategy();
    const { legacySnapshot, mtfSnapshot } = createMarketSnapshotPair();

    const legacyContext = new StrategyContext(legacySnapshot, 1000);
    const mtfContext = new StrategyContext(mtfSnapshot, 1000);

    const legacyRes = strategy.evaluate(legacyContext);
    const mtfRes = strategy.evaluate(mtfContext);

    expect(mtfRes.hasSignal).toBe(legacyRes.hasSignal);
    expect(mtfRes.confidenceScore).toBe(legacyRes.confidenceScore);
  });

  it('test_mean_reversion_option_a_equivalence: Asserts MeanReversion Option A 15m decision gate parity', () => {
    const strategy = new MeanReversionStrategy();
    const { legacySnapshot, mtfSnapshot } = createMarketSnapshotPair();

    const legacyContext = new StrategyContext(legacySnapshot, 1000);
    const mtfContext = new StrategyContext(mtfSnapshot, 1000);

    const legacyRes = strategy.evaluate(legacyContext);
    const mtfRes = strategy.evaluate(mtfContext);

    expect(mtfRes.hasSignal).toBe(legacyRes.hasSignal);
    expect(mtfRes.confidenceScore).toBe(legacyRes.confidenceScore);
  });

  it('test_vwap_option_a_equivalence: Asserts VWAP Option A 15m decision gate parity', () => {
    const strategy = new VWAPStrategy();
    const { legacySnapshot, mtfSnapshot } = createMarketSnapshotPair();

    const legacyContext = new StrategyContext(legacySnapshot, 1000);
    const mtfContext = new StrategyContext(mtfSnapshot, 1000);

    const legacyRes = strategy.evaluate(legacyContext);
    const mtfRes = strategy.evaluate(mtfContext);

    expect(mtfRes.hasSignal).toBe(legacyRes.hasSignal);
    expect(mtfRes.confidenceScore).toBe(legacyRes.confidenceScore);
  });

  it('test_confidence_score_mitigation_parity: Asserts returned confidenceScore matches primary timeframe evidence', () => {
    const strategies = [
      new ScalperV2Strategy(),
      new MomentumStrategy(),
      new BreakoutStrategy(),
      new MeanReversionStrategy(),
      new VWAPStrategy(),
    ];

    const { legacySnapshot, mtfSnapshot } = createMarketSnapshotPair();

    for (const strategy of strategies) {
      const legRes = strategy.evaluate(new StrategyContext(legacySnapshot, 1000));
      const mtfRes = strategy.evaluate(new StrategyContext(mtfSnapshot, 1000));

      // With confidence score mitigation, presence of 1h/4h does not distort primary confidenceScore
      expect(mtfRes.confidenceScore).toBe(legRes.confidenceScore);
    }
  });

  it('test_zero_network_calls_during_evaluation: Asserts 0 fetch calls during matrix evaluation', async () => {
    const mockProvider = {
      fetchCandles: vi.fn(),
      fetchKlines: vi.fn(),
      fetchTicker: vi.fn(),
    };
    const store = new MultiTimeframeCandleStore(mockProvider as any, 250);

    // Populate store with in-memory fixtures
    const now = Date.now();
    for (const tf of ['5m', '15m', '1h', '4h'] as const) {
      const series: StoredCandleSeries = {
        symbol: 'BTCUSDT',
        timeframe: tf,
        candles: generateCandles(250),
        fetchedAt: now,
        expiresAt: now + 3600_000,
        isFresh: true,
        hasGaps: false,
        isDegraded: false,
      };
      store.setSeries('BTCUSDT', tf, series);
    }

    const evaluator = new MatrixEvaluator();
    const report = await evaluator.evaluate({
      candidates: [{ index: 1, symbol: 'BTCUSDT' }],
      candleStore: store,
    });

    expect(report.terminalCells).toBe(5);
    expect(report.networkCallsDetected).toBe(0);

    // Hard invariant: Provider must NOT have been called even once during evaluation!
    expect(mockProvider.fetchCandles).toHaveBeenCalledTimes(0);
    expect(mockProvider.fetchKlines).toHaveBeenCalledTimes(0);
    expect(mockProvider.fetchTicker).toHaveBeenCalledTimes(0);
  });
});
