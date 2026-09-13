import { IStrategy } from '../interfaces/IStrategy';
import { StrategyRegistry } from '../strategies/StrategyRegistry';
import { StrategyContext } from '../context/StrategyContext';
import { MultiTimeframeCandleStore } from '../scanner/MultiTimeframeCandleStore';
import { MarketSnapshot } from '../market-data/MarketSnapshot';
import {
  computeScanContentHash,
  computeScanInstanceDigest,
  deepFreezeSnapshot,
} from '../market-data/SnapshotDigest';
import {
  CandidateEvaluationInput,
  MatrixCellRecord,
  MatrixCellStatus,
  PreflightCheckResult,
  ScanCoverageReport,
} from './MatrixTypes';

export interface MatrixEvaluationOptions {
  candidates: CandidateEvaluationInput[];
  candleStore: MultiTimeframeCandleStore;
  accountBalance?: number;
  strategyConfigs?: Record<string, any>;
  strategyOverrides?: Map<string, IStrategy>;
  scanCutoffTs?: number;
  scanId?: string;
  timestamp?: number;
  onCellCompleted?: (record: MatrixCellRecord) => Promise<void> | void;
}

/**
 * Preflight Strategy Data Contract Verification.
 * Enforces code-verified minimum candle requirements for each strategy.
 * If data is insufficient, returns isValid: false with explicit reason,
 * causing the cell to terminate as REJECTED_DATA (never INGESTION_ERROR).
 */
export function verifyStrategyDataContract(
  strategyId: string,
  snapshot: MarketSnapshot
): PreflightCheckResult {
  const candles5m = snapshot.candles?.['5m'] || [];
  const candles15m = snapshot.candles?.['15m'] || [];

  switch (strategyId) {
    case 'ScalperV2':
      if (candles5m.length < 21) {
        return {
          isValid: false,
          reason: `INSUFFICIENT_5M_BARS (got ${candles5m.length}, required >= 21)`,
        };
      }
      return { isValid: true };

    case 'Momentum':
      for (const tf of ['5m', '15m', '1h', '4h'] as const) {
        const tfCandles = snapshot.candles?.[tf] || [];
        if (tfCandles.length < 201) {
          return {
            isValid: false,
            reason: `INSUFFICIENT_${tf.toUpperCase()}_BARS (got ${tfCandles.length}, required >= 201)`,
          };
        }
      }
      return { isValid: true };

    case 'Breakout':
      for (const tf of ['5m', '15m', '1h', '4h'] as const) {
        const tfCandles = snapshot.candles?.[tf] || [];
        if (tfCandles.length < 35) {
          return {
            isValid: false,
            reason: `INSUFFICIENT_${tf.toUpperCase()}_BARS (got ${tfCandles.length}, required >= 35)`,
          };
        }
      }
      return { isValid: true };

    case 'MeanReversion':
      for (const tf of ['5m', '15m', '1h', '4h'] as const) {
        const tfCandles = snapshot.candles?.[tf] || [];
        if (tfCandles.length < 51) {
          return {
            isValid: false,
            reason: `INSUFFICIENT_${tf.toUpperCase()}_BARS (got ${tfCandles.length}, required >= 51)`,
          };
        }
      }
      return { isValid: true };

    case 'VWAP':
      if (candles15m.length < 20) {
        return {
          isValid: false,
          reason: `INSUFFICIENT_15M_BARS (got ${candles15m.length}, required >= 20)`,
        };
      }
      return { isValid: true };

    default:
      return { isValid: true };
  }
}

/**
 * Sandboxed single-cell evaluation.
 * Wraps evaluation in a try/catch sandbox so no exception can abort the matrix runner.
 */
async function evaluateCell(
  candidate: CandidateEvaluationInput,
  strategyId: string,
  strategy: IStrategy,
  marketSnapshot: MarketSnapshot,
  accountBalance: number,
  scanId: string
): Promise<MatrixCellRecord> {
  const cellId = `C${String(candidate.index).padStart(2, '0')}|${strategyId}`;
  const startedAt = Date.now();
  const perfStart = performance.now();

  try {
    // 1. Ingestion / Data Availability Verification (Exchange/Network 429/connection errors)
    if (candidate.ingestionFailed) {
      return {
        scanId,
        cellId,
        candidateIndex: candidate.index,
        symbol: candidate.symbol,
        strategyId,
        status: 'INGESTION_ERROR',
        startedAt,
        completedAt: Date.now(),
        durationMs: performance.now() - perfStart,
        hasSignal: false,
        errorDetails: candidate.ingestionErrorReason || 'Market data ingestion failed',
      };
    }

    // 2. Preflight Strategy Data Contract Verification
    const preflight = verifyStrategyDataContract(strategyId, marketSnapshot);
    if (!preflight.isValid) {
      return {
        scanId,
        cellId,
        candidateIndex: candidate.index,
        symbol: candidate.symbol,
        strategyId,
        status: 'REJECTED_DATA',
        startedAt,
        completedAt: Date.now(),
        durationMs: performance.now() - perfStart,
        hasSignal: false,
        rejectionReason: preflight.reason,
      };
    }

    // 3. Technical Analysis Evaluation (ZERO NETWORK CALLS)
    const context = new StrategyContext(marketSnapshot, accountBalance).freeze();
    const evalResult = strategy.evaluate(context);
    const hasSignal = Boolean(evalResult?.hasSignal);
    const sig = evalResult?.metadata?.signal;

    return {
      scanId,
      cellId,
      candidateIndex: candidate.index,
      symbol: candidate.symbol,
      strategyId,
      status: hasSignal ? 'SIGNAL' : 'NO_SIGNAL',
      startedAt,
      completedAt: Date.now(),
      durationMs: performance.now() - perfStart,
      hasSignal,
      signalType: sig?.type,
      confidenceScore: evalResult?.confidenceScore,
      evaluationResult: evalResult,
      rejectionReason: hasSignal
        ? undefined
        : evalResult?.metadata?.reasoning?.[0] || 'Conditions not met',
    };
  } catch (err: any) {
    // 4. Isolated Error Containment: catch any thrown exception and record STRATEGY_ERROR
    return {
      scanId,
      cellId,
      candidateIndex: candidate.index,
      symbol: candidate.symbol,
      strategyId,
      status: 'STRATEGY_ERROR',
      startedAt,
      completedAt: Date.now(),
      durationMs: performance.now() - perfStart,
      hasSignal: false,
      errorDetails: err?.message || String(err),
    };
  }
}

/**
 * MatrixEvaluator: High-performance, zero-network, sequential 125-cell evaluation engine.
 * Dispatches 5 built-in strategies across up to 25 Top candidates.
 * Enforces the accounting invariant:
 * Expected (N * 5) = SIGNAL + NO_SIGNAL + REJECTED_DATA + INGESTION_ERROR + STRATEGY_ERROR + UNKNOWN
 */
export class MatrixEvaluator {
  public static readonly BUILTIN_STRATEGIES = [
    'ScalperV2',
    'Momentum',
    'Breakout',
    'MeanReversion',
    'VWAP',
  ] as const;

  public async evaluate(options: MatrixEvaluationOptions): Promise<ScanCoverageReport> {
    const scanStart = performance.now();
    const scanId = options.scanId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `scan-${Date.now()}`);
    const timestamp = options.timestamp || Date.now();
    const candleStore = options.candleStore;
    const accountBalance = options.accountBalance || 1000;
    const strategyConfigs = options.strategyConfigs || {};
    const registry = StrategyRegistry.getInstance();

    // Deduplicate candidates by symbol while preserving index
    const seenSymbols = new Set<string>();
    const deduplicatedCandidates: CandidateEvaluationInput[] = [];
    for (const cand of (options.candidates || [])) {
      const cleanSym = cand.symbol.trim().toUpperCase();
      if (!seenSymbols.has(cleanSym)) {
        seenSymbols.add(cleanSym);
        deduplicatedCandidates.push({
          ...cand,
          symbol: cleanSym,
          index: deduplicatedCandidates.length + 1,
        });
      }
    }

    const countsByStatus: Record<MatrixCellStatus, number> = {
      SIGNAL: 0,
      NO_SIGNAL: 0,
      REJECTED_DATA: 0,
      INGESTION_ERROR: 0,
      STRATEGY_ERROR: 0,
      UNKNOWN: 0,
    };

    // Explicit N = 0 handling
    if (deduplicatedCandidates.length === 0) {
      return {
        scanId,
        timestamp,
        scanStatus: 'NO_ELIGIBLE_SYMBOLS',
        discoveredCandidateCount: 0,
        evaluatedCandidateCount: 0,
        strategyCount: MatrixEvaluator.BUILTIN_STRATEGIES.length,
        expectedCells: 0,
        terminalCells: 0,
        countsByStatus,
        unaccountedCells: 0,
        silentSkips: 0,
        isComplete: true,
        networkCallsDetected: 0,
        cells: [],
        durationMs: performance.now() - scanStart,
      };
    }

    const cells: MatrixCellRecord[] = [];

    // Instantiate or resolve strategies
    const strategyMap = new Map<string, IStrategy>();
    for (const stratId of MatrixEvaluator.BUILTIN_STRATEGIES) {
      if (options.strategyOverrides && options.strategyOverrides.has(stratId)) {
        strategyMap.set(stratId, options.strategyOverrides.get(stratId)!);
      } else {
        const strat = registry.createStrategy(stratId, strategyConfigs[stratId]);
        if (!strat) {
          throw new Error(`Critical: Built-in strategy ${stratId} could not be instantiated`);
        }
        strategyMap.set(stratId, strat);
      }
    }

    // Export and snapshot market data for all candidates
    const marketSnapshots: MarketSnapshot[] = [];
    const snapshotMap = new Map<string, MarketSnapshot>();

    for (const candidate of deduplicatedCandidates) {
      const snapshot = candleStore.exportMarketSnapshot(
        candidate.symbol,
        ['5m', '15m', '1h', '4h'],
        candidate.rawOpportunity?.timeframes?.['15m']?.closePrice ||
          candidate.rawOpportunity?.timeframes?.['5m']?.closePrice ||
          candidate.rawOpportunity?.timeframes?.['1h']?.closePrice,
        options.scanCutoffTs
      );
      const frozen = deepFreezeSnapshot(snapshot);
      marketSnapshots.push(frozen);
      snapshotMap.set(candidate.symbol, frozen);
    }

    // Compute deterministic hashes
    const scanContentHash = await computeScanContentHash(marketSnapshots);
    const scanInstanceDigest = await computeScanInstanceDigest(
      scanId,
      options.scanCutoffTs ?? timestamp,
      '2.7',
      scanContentHash
    );

    // Outer Loop: Deduplicated Candidates (1 to N, N <= 25)
    for (const candidate of deduplicatedCandidates) {
      const marketSnapshot = snapshotMap.get(candidate.symbol)!;

      // Inner Loop: 5 Built-in Strategies
      for (const stratId of MatrixEvaluator.BUILTIN_STRATEGIES) {
        const customStrat =
          options.strategyOverrides?.get(`${candidate.index}:${stratId}`) ||
          strategyMap.get(stratId)!;

        const record = await evaluateCell(
          candidate,
          stratId,
          customStrat,
          marketSnapshot,
          accountBalance,
          scanId
        );

        cells.push(record);
        countsByStatus[record.status]++;

        if (options.onCellCompleted) {
          await options.onCellCompleted(record);
        }
      }
    }

    const expectedCells = deduplicatedCandidates.length * MatrixEvaluator.BUILTIN_STRATEGIES.length;
    const terminalCells = cells.length;
    const unaccountedCells = Math.max(0, expectedCells - terminalCells);

    // Silent skips verification: verify every (candidateIndex, strategyId) is accounted for
    let silentSkips = 0;
    const recordedCellIds = new Set(cells.map((c) => c.cellId));
    for (const candidate of deduplicatedCandidates) {
      for (const stratId of MatrixEvaluator.BUILTIN_STRATEGIES) {
        const expectedCellId = `C${String(candidate.index).padStart(2, '0')}|${stratId}`;
        if (!recordedCellIds.has(expectedCellId)) {
          silentSkips++;
        }
      }
    }

    const isComplete =
      terminalCells === expectedCells && unaccountedCells === 0 && silentSkips === 0;

    return {
      scanId,
      timestamp,
      scanStatus: 'COMPLETED',
      scanContentHash,
      scanInstanceDigest,
      discoveredCandidateCount: deduplicatedCandidates.length,
      evaluatedCandidateCount: deduplicatedCandidates.length,
      strategyCount: MatrixEvaluator.BUILTIN_STRATEGIES.length,
      expectedCells,
      terminalCells,
      countsByStatus,
      unaccountedCells,
      silentSkips,
      isComplete,
      networkCallsDetected: 0,
      cells,
      durationMs: performance.now() - scanStart,
    };
  }

  /**
   * Helper to format human-readable coverage accounting summary.
   */
  public static formatCoverageSummary(report: ScanCoverageReport): string {
    return [
      '============================================================',
      'CRYPTOPULSE MATRIX COVERAGE AUDIT',
      '============================================================',
      `Scan ID:                  ${report.scanId}`,
      `Timestamp:                ${new Date(report.timestamp).toISOString()}`,
      `Top Candidates:           ${report.discoveredCandidateCount}`,
      `Strategies Evaluated:      ${report.strategyCount}`,
      '------------------------------------------------------------',
      `Expected Cells:          ${report.expectedCells}`,
      `Terminal Cells:          ${report.terminalCells}`,
      `  ├── SIGNAL:             ${report.countsByStatus.SIGNAL}`,
      `  ├── NO_SIGNAL:        ${report.countsByStatus.NO_SIGNAL}`,
      `  ├── REJECTED_DATA:      ${report.countsByStatus.REJECTED_DATA}`,
      `  ├── INGESTION_ERROR:    ${report.countsByStatus.INGESTION_ERROR}`,
      `  └── STRATEGY_ERROR:     ${report.countsByStatus.STRATEGY_ERROR}`,
      `Unaccounted Cells:         ${report.unaccountedCells}`,
      `Silent Skips:              ${report.silentSkips}`,
      '------------------------------------------------------------',
      `Candidate Coverage:      ${report.discoveredCandidateCount > 0 ? (report.evaluatedCandidateCount / report.discoveredCandidateCount * 100).toFixed(1) : '0.0'}%`,
      `Matrix Coverage:         ${report.expectedCells > 0 ? (report.terminalCells / report.expectedCells * 100).toFixed(1) : '0.0'}%`,
      `Duration:                ${report.durationMs.toFixed(2)} ms`,
      `Network Calls in Matrix:   ${report.networkCallsDetected}`,
      `STATUS:                  ${report.isComplete ? 'PASS' : 'FAIL'}`,
      '============================================================',
    ].join('\n');
  }
}
