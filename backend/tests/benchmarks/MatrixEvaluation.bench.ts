import { bench, describe } from 'vitest';
import { MatrixEvaluator } from '../../src/engine/matrix/MatrixEvaluator';
import { CandidateEvaluationInput } from '../../src/engine/matrix/MatrixTypes';
import { MultiTimeframeCandleStore, StoredCandleSeries } from '../../src/engine/scanner/MultiTimeframeCandleStore';
import { NormalizedCandle } from '../../src/engine/market-data/MarketSnapshot';

function makeCandles(count: number): NormalizedCandle[] {
  const startTs = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => ({
    timestamp: startTs + i * 60_000,
    openTime: startTs + i * 60_000,
    open: 150 + Math.sin(i * 0.1) * 10,
    high: 155 + Math.sin(i * 0.1) * 10,
    low: 145 + Math.sin(i * 0.1) * 10,
    close: 150 + Math.cos(i * 0.1) * 10,
    volume: 1000 + i * 5,
  }));
}

function setupBenchmarkFixtures(symbolCount: number): {
  evaluator: MatrixEvaluator;
  candidates: CandidateEvaluationInput[];
  store: MultiTimeframeCandleStore;
} {
  const evaluator = new MatrixEvaluator();
  const mockProvider = {
    fetchCandles: () => Promise.reject(new Error('NETWORK_DISABLED')),
    fetchKlines: () => Promise.reject(new Error('NETWORK_DISABLED')),
    fetchTicker: () => Promise.reject(new Error('NETWORK_DISABLED')),
  };
  const store = new MultiTimeframeCandleStore(mockProvider as any, 200);

  const candles100 = makeCandles(100);
  const candles200 = makeCandles(200);
  const now = Date.now();

  const candidates: CandidateEvaluationInput[] = [];

  for (let i = 1; i <= symbolCount; i++) {
    const symbol = `SYM${i}USDT`;
    const s5m: StoredCandleSeries = {
      symbol,
      timeframe: '5m',
      candles: candles100,
      fetchedAt: now,
      expiresAt: now + 3600_000,
      isFresh: true,
      hasGaps: false,
      isDegraded: false,
    };
    const s15m: StoredCandleSeries = {
      symbol,
      timeframe: '15m',
      candles: candles200,
      fetchedAt: now,
      expiresAt: now + 3600_000,
      isFresh: true,
      hasGaps: false,
      isDegraded: false,
    };
    const s1h: StoredCandleSeries = {
      symbol,
      timeframe: '1h',
      candles: candles200,
      fetchedAt: now,
      expiresAt: now + 3600_000,
      isFresh: true,
      hasGaps: false,
      isDegraded: false,
    };

    store.setSeries(symbol, '5m', s5m);
    store.setSeries(symbol, '15m', s15m);
    store.setSeries(symbol, '1h', s1h);

    candidates.push({
      index: i,
      symbol,
      rawOpportunity: {
        symbol,
        currentRank: i,
        timeframes: {
          '15m': { closePrice: 150 },
          '5m': { closePrice: 150 },
        },
      },
    });
  }

  return { evaluator, candidates, store };
}

const f10 = setupBenchmarkFixtures(10);
const f25 = setupBenchmarkFixtures(25);
const f50 = setupBenchmarkFixtures(50);

describe('MatrixEvaluator Performance Benchmark', () => {
  bench('10 candidates × 5 strategies (50 cells)', async () => {
    await f10.evaluator.evaluate({
      candidates: f10.candidates,
      candleStore: f10.store,
    });
  });

  bench('25 candidates × 5 strategies (125 cells) [TARGET <= 60ms]', async () => {
    await f25.evaluator.evaluate({
      candidates: f25.candidates,
      candleStore: f25.store,
    });
  });

  bench('50 candidates × 5 strategies (250 cells)', async () => {
    await f50.evaluator.evaluate({
      candidates: f50.candidates,
      candleStore: f50.store,
    });
  });
});
