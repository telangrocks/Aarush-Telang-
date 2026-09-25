import { describe, it, expect, vi } from 'vitest';
import { MatrixEvaluator } from '../../src/engine/matrix/MatrixEvaluator';
import { CandidateEvaluationInput } from '../../src/engine/matrix/MatrixTypes';
import { MultiTimeframeCandleStore, StoredCandleSeries } from '../../src/engine/scanner/MultiTimeframeCandleStore';
import { NormalizedCandle } from '../../src/engine/market-data/MarketSnapshot';

function makeCandles(count: number, basePrice: number = 100): NormalizedCandle[] {
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

function createMockCandleStore(): MultiTimeframeCandleStore {
  const mockProvider = {
    fetchCandles: vi.fn().mockRejectedValue(new Error('NETWORK_DISABLED_IN_TEST')),
    fetchKlines: vi.fn().mockRejectedValue(new Error('NETWORK_DISABLED_IN_TEST')),
    fetchTicker: vi.fn().mockRejectedValue(new Error('NETWORK_DISABLED_IN_TEST')),
  };
  return new MultiTimeframeCandleStore(mockProvider as any, 250);
}

function populateStoreForSymbol(
  store: MultiTimeframeCandleStore,
  symbol: string,
  counts: { '5m'?: number; '15m'?: number; '1h'?: number; '4h'?: number } = {
    '5m': 100,
    '15m': 250,
    '1h': 250,
    '4h': 250,
  }
): void {
  const now = Date.now();
  const tfs: Array<'5m' | '15m' | '1h' | '4h'> = ['5m', '15m', '1h', '4h'];
  for (const tf of tfs) {
    const cCount = counts[tf];
    if (cCount && cCount > 0) {
      const candles = makeCandles(cCount);
      const series: StoredCandleSeries = {
        symbol,
        timeframe: tf,
        candles,
        fetchedAt: now,
        expiresAt: now + 3600_000,
        isFresh: true,
        hasGaps: false,
        isDegraded: false,
      };
      store.setSeries(symbol, tf, series);
    }
  }
}

const SYMBOLS_25 = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  'NEARUSDT', 'MATICUSDT', 'UNIUSDT', 'LTCUSDT', 'ATOMUSDT',
  'APTUSDT', 'OPUSDT', 'ARBUSDT', 'FILUSDT', 'INJUSDT',
  'SUIUSDT', 'RNDRUSDT', 'FETUSDT', 'TIAUSDT', 'STXUSDT',
];

describe('Suite 1: Matrix Coverage & Universe Sizing (MatrixMTFCoverage)', () => {
  const evaluator = new MatrixEvaluator();

  it('test_universe_exact_25_coins: Validates 25 coins produce exactly 125 expected cells', async () => {
    const store = createMockCandleStore();
    const candidates: CandidateEvaluationInput[] = SYMBOLS_25.map((symbol, idx) => {
      populateStoreForSymbol(store, symbol);
      return {
        index: idx + 1,
        symbol,
        rawOpportunity: { symbol, timeframes: { '15m': { closePrice: 100 } } },
      };
    });

    const report = await evaluator.evaluate({
      candidates,
      candleStore: store,
      accountBalance: 1000,
    });

    expect(report.discoveredCandidateCount).toBe(25);
    expect(report.evaluatedCandidateCount).toBe(25);
    expect(report.strategyCount).toBe(5);
    expect(report.expectedCells).toBe(125);
    expect(report.terminalCells).toBe(125);
    expect(report.unaccountedCells).toBe(0);
    expect(report.silentSkips).toBe(0);
    expect(report.isComplete).toBe(true);
    expect(report.cells.length).toBe(125);
    expect(report.scanStatus).toBe('COMPLETED');
    expect(report.scanContentHash).toBeDefined();
    expect(report.scanInstanceDigest).toBeDefined();

    const sum =
      report.countsByStatus.SIGNAL +
      report.countsByStatus.NO_SIGNAL +
      report.countsByStatus.REJECTED_DATA +
      report.countsByStatus.INGESTION_ERROR +
      report.countsByStatus.STRATEGY_ERROR +
      report.countsByStatus.UNKNOWN;
    expect(sum).toBe(125);
  });

  it('test_universe_partial_21_coins: Validates 21 coins produce exactly 105 expected cells', async () => {
    const store = createMockCandleStore();
    const symbols21 = SYMBOLS_25.slice(0, 21);
    const candidates: CandidateEvaluationInput[] = symbols21.map((symbol, idx) => {
      populateStoreForSymbol(store, symbol);
      return {
        index: idx + 1,
        symbol,
        rawOpportunity: { symbol, timeframes: { '15m': { closePrice: 100 } } },
      };
    });

    const report = await evaluator.evaluate({
      candidates,
      candleStore: store,
      accountBalance: 1000,
    });

    expect(report.discoveredCandidateCount).toBe(21);
    expect(report.evaluatedCandidateCount).toBe(21);
    expect(report.expectedCells).toBe(105);
    expect(report.terminalCells).toBe(105);
    expect(report.unaccountedCells).toBe(0);
    expect(report.silentSkips).toBe(0);
    expect(report.isComplete).toBe(true);
    expect(report.cells.length).toBe(105);
  });

  it('test_universe_zero_coins: Validates N = 0 completes as NO_ELIGIBLE_SYMBOLS (0 cells)', async () => {
    const store = createMockCandleStore();
    const report = await evaluator.evaluate({
      candidates: [],
      candleStore: store,
      accountBalance: 1000,
    });

    expect(report.discoveredCandidateCount).toBe(0);
    expect(report.evaluatedCandidateCount).toBe(0);
    expect(report.expectedCells).toBe(0);
    expect(report.terminalCells).toBe(0);
    expect(report.unaccountedCells).toBe(0);
    expect(report.silentSkips).toBe(0);
    expect(report.isComplete).toBe(true);
    expect(report.cells.length).toBe(0);
    expect(report.scanStatus).toBe('NO_ELIGIBLE_SYMBOLS');
  });

  it('test_universe_symbol_deduplication: Validates duplicate candidates are deduplicated before matrix execution', async () => {
    const store = createMockCandleStore();
    populateStoreForSymbol(store, 'BTCUSDT');
    populateStoreForSymbol(store, 'ETHUSDT');

    const duplicateCandidates: CandidateEvaluationInput[] = [
      { index: 1, symbol: 'BTCUSDT' },
      { index: 2, symbol: 'btcusdt' }, // duplicate with case difference
      { index: 3, symbol: 'ETHUSDT' },
      { index: 4, symbol: 'BTCUSDT' }, // duplicate
    ];

    const report = await evaluator.evaluate({
      candidates: duplicateCandidates,
      candleStore: store,
    });

    // 2 unique symbols -> 2 * 5 = 10 cells
    expect(report.discoveredCandidateCount).toBe(2);
    expect(report.evaluatedCandidateCount).toBe(2);
    expect(report.expectedCells).toBe(10);
    expect(report.terminalCells).toBe(10);
    expect(report.isComplete).toBe(true);
  });
});
