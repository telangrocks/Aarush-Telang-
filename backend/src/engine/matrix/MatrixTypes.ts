import { EvaluationResult } from '../dto/EvaluationResult';

/**
 * The mutually exclusive terminal states for each evaluation cell.
 * Accounting identity invariant:
 * Expected (N * 5) = SIGNAL + NO_SIGNAL + REJECTED_DATA + INGESTION_ERROR + STRATEGY_ERROR + UNKNOWN
 */
export type MatrixCellStatus =
  | 'SIGNAL'
  | 'NO_SIGNAL'
  | 'REJECTED_DATA'
  | 'INGESTION_ERROR'
  | 'STRATEGY_ERROR'
  | 'UNKNOWN';

export type ScanLifecycleStatus =
  | 'NOT_RUNNING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'ABORTED'
  | 'FAILED'
  | 'NO_ELIGIBLE_SYMBOLS';

export interface MatrixCellRecord {
  readonly scanId: string;
  readonly cellId: string;          // e.g. "C01|ScalperV2", "C25|VWAP"
  readonly candidateIndex: number;  // 1 to 25
  readonly symbol: string;          // e.g. "BTCUSDT"
  readonly strategyId: string;      // "ScalperV2" | "Momentum" | "Breakout" | "MeanReversion" | "VWAP"
  readonly status: MatrixCellStatus;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly rejectionReason?: string;
  readonly errorDetails?: string;
  readonly hasSignal: boolean;
  readonly signalType?: 'BUY' | 'SELL';
  readonly confidenceScore?: number;
  readonly evaluationResult?: EvaluationResult;
}

export interface ScanCoverageReport {
  readonly scanId: string;
  readonly timestamp: number;
  readonly scanStatus?: ScanLifecycleStatus;
  readonly scanContentHash?: string;
  readonly scanInstanceDigest?: string;
  readonly discoveredCandidateCount: number;
  readonly evaluatedCandidateCount: number;
  readonly strategyCount: number;
  readonly expectedCells: number;
  readonly terminalCells: number;
  readonly countsByStatus: Record<MatrixCellStatus, number>;
  readonly unaccountedCells: number;
  readonly silentSkips: number;
  readonly isComplete: boolean;
  readonly networkCallsDetected: number;
  readonly cells: MatrixCellRecord[];
  readonly durationMs: number;
}

export interface CandidateEvaluationInput {
  readonly index: number;          // 1-based index (1 to 25)
  readonly symbol: string;
  readonly ingestionFailed?: boolean;
  readonly ingestionErrorReason?: string;
  readonly rawOpportunity?: any;
}

export interface PreflightCheckResult {
  readonly isValid: boolean;
  readonly reason?: string;
}
