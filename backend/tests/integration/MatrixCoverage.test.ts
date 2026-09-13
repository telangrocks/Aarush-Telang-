import { describe, it, expect, vi } from 'vitest';
import { MatrixEvaluator } from '../../src/engine/matrix/MatrixEvaluator';
import { CandidateEvaluationInput, MatrixCellStatus } from '../../src/engine/matrix/MatrixTypes';
import { MultiTimeframeCandleStore, StoredCandleSeries } from '../../src/engine/scanner/MultiTimeframeCandleStore';
import { NormalizedCandle } from '../../src/engine/market-data/MarketSnapshot';
import { IStrategy } from '../../src/engine/interfaces/IStrategy';
import { StrategyContext } from '../../src/engine/context/StrategyContext';
import { EvaluationResult } from '../../src/engine/dto/EvaluationResult';

// ---- Fixture Helpers ----

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
    '5m': 250,
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

function create25Candidates(store: MultiTimeframeCandleStore): CandidateEvaluationInput[] {
  return SYMBOLS_25.map((symbol, idx) => {
    populateStoreForSymbol(store, symbol);
    return {
      index: idx + 1,
      symbol,
      rawOpportunity: {
        symbol,
        currentRank: idx + 1,
        timeframes: {
          '15m': { closePrice: 100 },
          '5m': { closePrice: 100 },
        },
      },
    };
  });
}

describe('CryptoPulse — Phase 1 Matrix Coverage Forensic Audit Suite', () => {
  const evaluator = new MatrixEvaluator();

  // --------------------------------------------------------------------------
  // TEST 1: Full Matrix Completeness (25 Candidates × 5 Strategies = 125 Cells)
  // --------------------------------------------------------------------------
  it('Test 1 [Full Matrix Completeness]: produces exactly 125 terminal cells for 25 candidates with 0 skips', async () => {
    const store = createMockCandleStore();
    const candidates = create25Candidates(store);

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

    // Verify accounting sum identity
    const sum =
      report.countsByStatus.SIGNAL +
      report.countsByStatus.NO_SIGNAL +
      report.countsByStatus.REJECTED_DATA +
      report.countsByStatus.INGESTION_ERROR +
      report.countsByStatus.STRATEGY_ERROR;
    expect(sum).toBe(125);
  });

  // --------------------------------------------------------------------------
  // TEST 2: Candidate Failure Isolation (Cell-level try/catch sandbox)
  // --------------------------------------------------------------------------
  it('Test 2 [Candidate Failure Isolation]: isolated exception in C07|Breakout records STRATEGY_ERROR; remaining 124 cells complete', async () => {
    const store = createMockCandleStore();
    const candidates = create25Candidates(store);

    const throwingBreakout: IStrategy = {
      manifest: { id: 'Breakout', name: 'Breakout Strategy', version: '1.0.0' } as any,
      evaluate: () => {
        throw new Error('SIMULATED_STRATEGY_CRASH_IN_C07_BREAKOUT');
      },
    };

    const strategyOverrides = new Map<string, IStrategy>();
    // Target Candidate #7, Strategy Breakout
    strategyOverrides.set('7:Breakout', throwingBreakout);

    const report = await evaluator.evaluate({
      candidates,
      candleStore: store,
      strategyOverrides,
    });

    expect(report.expectedCells).toBe(125);
    expect(report.terminalCells).toBe(125);
    expect(report.unaccountedCells).toBe(0);
    expect(report.silentSkips).toBe(0);

    const brokenCell = report.cells.find((c) => c.cellId === 'C07|Breakout');
    expect(brokenCell).toBeDefined();
    expect(brokenCell?.status).toBe('STRATEGY_ERROR');
    expect(brokenCell?.errorDetails).toContain('SIMULATED_STRATEGY_CRASH_IN_C07_BREAKOUT');

    // Confirm that Candidate #7 other strategies still executed
    const c07Scalper = report.cells.find((c) => c.cellId === 'C07|ScalperV2');
    expect(c07Scalper?.status).not.toBe('STRATEGY_ERROR');
    const c07Momentum = report.cells.find((c) => c.cellId === 'C07|Momentum');
    expect(c07Momentum?.status).not.toBe('STRATEGY_ERROR');

    // Exactly 1 STRATEGY_ERROR in entire report
    expect(report.countsByStatus.STRATEGY_ERROR).toBe(1);
    expect(report.isComplete).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 3: Missing Data Handling (Preflight contract -> REJECTED_DATA)
  // --------------------------------------------------------------------------
  it('Test 3 [Missing Data Handling]: insufficient 15M candles on Candidate #4 records REJECTED_DATA for 15M strategies; matrix reaches 125', async () => {
    const store = createMockCandleStore();
    const candidates = create25Candidates(store);

    // Candidate #4 (index 4) has only 5 bars on 15M (insufficient for all 5 strategies requiring 15m)
    // Non-15M timeframes are fully populated with 250 bars
    const c4Symbol = candidates[3].symbol;
    populateStoreForSymbol(store, c4Symbol, { '5m': 250, '15m': 5, '1h': 250, '4h': 250 });

    const report = await evaluator.evaluate({
      candidates,
      candleStore: store,
    });

    expect(report.expectedCells).toBe(125);
    expect(report.terminalCells).toBe(125);
    expect(report.unaccountedCells).toBe(0);

    // C04|ScalperV2 requires >= 35 candles on 15m; with only 5 bars it is REJECTED_DATA
    const c04Scalper = report.cells.find((c) => c.cellId === 'C04|ScalperV2');
    expect(c04Scalper?.status).toBe('REJECTED_DATA');
    expect(c04Scalper?.rejectionReason).toContain('INSUFFICIENT_15M_BARS');

    // C04|Momentum, Breakout, MeanReversion, VWAP should be REJECTED_DATA
    const c04Momentum = report.cells.find((c) => c.cellId === 'C04|Momentum');
    expect(c04Momentum?.status).toBe('REJECTED_DATA');
    expect(c04Momentum?.rejectionReason).toContain('INSUFFICIENT_15M_BARS');

    const c04Breakout = report.cells.find((c) => c.cellId === 'C04|Breakout');
    expect(c04Breakout?.status).toBe('REJECTED_DATA');

    const c04MeanRev = report.cells.find((c) => c.cellId === 'C04|MeanReversion');
    expect(c04MeanRev?.status).toBe('REJECTED_DATA');

    const c04VWAP = report.cells.find((c) => c.cellId === 'C04|VWAP');
    expect(c04VWAP?.status).toBe('REJECTED_DATA');

    // All 5 strategies on C04 are REJECTED_DATA due to insufficient 15m candles
    expect(report.countsByStatus.REJECTED_DATA).toBe(5);
    expect(report.isComplete).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 4: Multiple Simultaneous Faults
  // --------------------------------------------------------------------------
  it('Test 4 [Multiple Simultaneous Faults]: C02 throws, C08 has ingestion failure, C15 throws in S04; exactly 125 cells terminal', async () => {
    const store = createMockCandleStore();
    const candidates = create25Candidates(store);

    // Fault 1: C08 has exchange ingestion failure
    candidates[7] = {
      ...candidates[7],
      ingestionFailed: true,
      ingestionErrorReason: 'HTTP_429_RATE_LIMIT_EXCEEDED',
    };

    // Fault 2: C02 throws across all strategies
    const throwingStrategy: IStrategy = {
      manifest: { id: 'ScalperV2' } as any,
      evaluate: () => {
        throw new Error('CORRUPT_CANDLE_INDICATOR_MATH');
      },
    };

    const strategyOverrides = new Map<string, IStrategy>();
    strategyOverrides.set('2:ScalperV2', throwingStrategy);
    strategyOverrides.set('15:MeanReversion', {
      manifest: { id: 'MeanReversion' } as any,
      evaluate: () => {
        throw new Error('D1_STORAGE_TIMEOUT');
      },
    });

    const report = await evaluator.evaluate({
      candidates,
      candleStore: store,
      strategyOverrides,
    });

    expect(report.expectedCells).toBe(125);
    expect(report.terminalCells).toBe(125);
    expect(report.unaccountedCells).toBe(0);
    expect(report.silentSkips).toBe(0);

    // C08: all 5 strategies must be INGESTION_ERROR
    const c08Cells = report.cells.filter((c) => c.candidateIndex === 8);
    expect(c08Cells.length).toBe(5);
    c08Cells.forEach((c) => {
      expect(c.status).toBe('INGESTION_ERROR');
      expect(c.errorDetails).toBe('HTTP_429_RATE_LIMIT_EXCEEDED');
    });

    // C02|ScalperV2: STRATEGY_ERROR
    const c02Scalper = report.cells.find((c) => c.cellId === 'C02|ScalperV2');
    expect(c02Scalper?.status).toBe('STRATEGY_ERROR');

    // C15|MeanReversion: STRATEGY_ERROR
    const c15MeanRev = report.cells.find((c) => c.cellId === 'C15|MeanReversion');
    expect(c15MeanRev?.status).toBe('STRATEGY_ERROR');

    expect(report.countsByStatus.INGESTION_ERROR).toBe(5);
    expect(report.countsByStatus.STRATEGY_ERROR).toBe(2);
    expect(report.isComplete).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 5: All No-Signal Scenario
  // --------------------------------------------------------------------------
  it('Test 5 [All No-Signal Scenario]: 0 signals across all 125 cells results in 125 NO_SIGNAL without early exit', async () => {
    const store = createMockCandleStore();
    const candidates = create25Candidates(store);

    // Flat price candles will not satisfy RSI, breakout, or momentum thresholds
    const flatCandles: NormalizedCandle[] = Array.from({ length: 250 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 60_000,
      openTime: 1_700_000_000_000 + i * 60_000,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 10,
    }));

    for (const sym of SYMBOLS_25) {
      for (const tf of ['5m', '15m', '1h', '4h'] as const) {
        store.setSeries(sym, tf, {
          symbol: sym,
          timeframe: tf,
          candles: flatCandles,
          fetchedAt: Date.now(),
          expiresAt: Date.now() + 3600_000,
          isFresh: true,
          hasGaps: false,
          isDegraded: false,
        });
      }
    }

    const report = await evaluator.evaluate({
      candidates,
      candleStore: store,
    });

    expect(report.expectedCells).toBe(125);
    expect(report.terminalCells).toBe(125);
    expect(report.countsByStatus.SIGNAL).toBe(0);
    expect(report.countsByStatus.NO_SIGNAL).toBe(125);
    expect(report.unaccountedCells).toBe(0);
    expect(report.silentSkips).toBe(0);
    expect(report.isComplete).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 6: Execution Guard Decoupling
  // --------------------------------------------------------------------------
  it('Test 6 [Execution Guard Decoupling]: simulated pending alert, open position, cooldown on C01 does not halt analysis of candidates 2-25', async () => {
    const store = createMockCandleStore();
    const candidates = create25Candidates(store);

    // Candidate 1 has execution flags attached in rawOpportunity
    candidates[0] = {
      ...candidates[0],
      rawOpportunity: {
        ...candidates[0].rawOpportunity,
        hasPendingAlert: true,
        hasOpenPosition: true,
        inCooldown: true,
      },
    };

    const report = await evaluator.evaluate({
      candidates,
      candleStore: store,
    });

    // MatrixEvaluator must evaluate ALL 25 candidates, including C01
    expect(report.discoveredCandidateCount).toBe(25);
    expect(report.evaluatedCandidateCount).toBe(25);
    expect(report.terminalCells).toBe(125);
    expect(report.unaccountedCells).toBe(0);

    // Candidate 1 cells were fully evaluated
    const c01Cells = report.cells.filter((c) => c.candidateIndex === 1);
    expect(c01Cells.length).toBe(5);

    // Candidates 2-25 were fully evaluated
    const c25Cells = report.cells.filter((c) => c.candidateIndex === 25);
    expect(c25Cells.length).toBe(5);
  });

  // --------------------------------------------------------------------------
  // TEST 7: Zero Network Calls Assertion
  // --------------------------------------------------------------------------
  it('Test 7 [Zero Network Calls Assertion]: MatrixEvaluator.evaluate() makes strictly 0 network/provider calls', async () => {
    const store = createMockCandleStore();
    const candidates = create25Candidates(store);

    // Mock global fetch
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;

    const report = await evaluator.evaluate({
      candidates,
      candleStore: store,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(report.networkCallsDetected).toBe(0);
    expect(report.terminalCells).toBe(125);
  });

  // --------------------------------------------------------------------------
  // TEST 8: Cell Identity Uniqueness
  // --------------------------------------------------------------------------
  it('Test 8 [Cell Identity Uniqueness]: all 125 cellId keys are distinct with zero collisions', async () => {
    const store = createMockCandleStore();
    const candidates = create25Candidates(store);

    const report = await evaluator.evaluate({
      candidates,
      candleStore: store,
    });

    expect(report.cells.length).toBe(125);
    const idSet = new Set(report.cells.map((c) => c.cellId));
    expect(idSet.size).toBe(125);

    // Verify format: C01|Strategy to C25|Strategy
    for (let idx = 1; idx <= 25; idx++) {
      for (const strat of MatrixEvaluator.BUILTIN_STRATEGIES) {
        const expectedKey = `C${String(idx).padStart(2, '0')}|${strat}`;
        expect(idSet.has(expectedKey)).toBe(true);
      }
    }
  });

  // --------------------------------------------------------------------------
  // TEST 9: Accounting Identity Invariant
  // --------------------------------------------------------------------------
  it('Test 9 [Accounting Identity Invariant]: SIGNAL + NO_SIGNAL + REJECTED_DATA + INGESTION_ERROR + STRATEGY_ERROR === 125 under mixed conditions', async () => {
    const store = createMockCandleStore();
    const candidates = create25Candidates(store);

    // Introduce varied conditions:
    // C01-C03: normal
    // C04: insufficient 15M data -> REJECTED_DATA for 4 strategies
    populateStoreForSymbol(store, candidates[3].symbol, { '5m': 100, '15m': 10, '1h': 100, '4h': 100 });
    // C09: Ingestion failure -> INGESTION_ERROR for all 5 strategies
    candidates[8] = { ...candidates[8], ingestionFailed: true, ingestionErrorReason: 'BYBIT_KLINE_429' };
    // C12: Strategy error on ScalperV2
    const strategyOverrides = new Map<string, IStrategy>();
    strategyOverrides.set('12:ScalperV2', {
      manifest: { id: 'ScalperV2' } as any,
      evaluate: () => {
        throw new Error('VOLATILITY_OVERFLOW');
      },
    });

    const report = await evaluator.evaluate({
      candidates,
      candleStore: store,
      strategyOverrides,
    });

    const { SIGNAL, NO_SIGNAL, REJECTED_DATA, INGESTION_ERROR, STRATEGY_ERROR } = report.countsByStatus;
    const sum = SIGNAL + NO_SIGNAL + REJECTED_DATA + INGESTION_ERROR + STRATEGY_ERROR;

    expect(sum).toBe(125);
    expect(report.terminalCells).toBe(125);
    expect(report.unaccountedCells).toBe(0);
    expect(report.silentSkips).toBe(0);
    expect(report.isComplete).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 10: Deterministic Replay
  // --------------------------------------------------------------------------
  it('Test 10 [Deterministic Replay]: replaying identical frozen fixtures produces identical 125-cell output and statuses', async () => {
    const store1 = createMockCandleStore();
    const candidates1 = create25Candidates(store1);

    const store2 = createMockCandleStore();
    const candidates2 = create25Candidates(store2);

    const frozenTs = 1_700_000_000_000;
    const run1 = await evaluator.evaluate({
      candidates: candidates1,
      candleStore: store1,
      timestamp: frozenTs,
      scanId: 'REPLAY_RUN_01',
    });

    const run2 = await evaluator.evaluate({
      candidates: candidates2,
      candleStore: store2,
      timestamp: frozenTs,
      scanId: 'REPLAY_RUN_02',
    });

    expect(run1.expectedCells).toBe(run2.expectedCells);
    expect(run1.terminalCells).toBe(run2.terminalCells);
    expect(run1.countsByStatus).toEqual(run2.countsByStatus);
    expect(run1.cells.length).toBe(run2.cells.length);

    for (let i = 0; i < 125; i++) {
      expect(run1.cells[i].cellId).toBe(run2.cells[i].cellId);
      expect(run1.cells[i].status).toBe(run2.cells[i].status);
      expect(run1.cells[i].strategyId).toBe(run2.cells[i].strategyId);
      expect(run1.cells[i].symbol).toBe(run2.cells[i].symbol);
    }
  });
});
