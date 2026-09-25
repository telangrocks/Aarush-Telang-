export type RejectionGate =
  | 'NONE'
  | 'INSUFFICIENT_MARKET_DATA'
  | 'STALE_MARKET_DATA'
  | 'NO_DIRECTIONAL_BIAS'
  | 'PRIMARY_SCORE_BELOW_THRESHOLD'
  | 'RISK_CLASSIFICATION_REJECTED'
  | 'SHORT_SIGNAL_SUPPRESSED'
  | 'CUSTOM_CONDITION_FAILED';

export interface ForensicTrace {
  cycleId?: string;
  strategyId: string;
  symbol: string;
  evaluationTimestamp: number;
  latestCandleTimestamp?: number;
  marketDataAgeMs?: number;
  overallScore: number;
  requiredScore: number;
  primaryTimeframe: string;
  primaryTimeframeScore: number;
  timeframeScores: Record<string, number>;
  trendDirection: string;
  emaCrossoverState?: string;
  proposedSignal: string;
  riskClassification?: string;
  signalValidator?: {
    isValid: boolean;
    scorePass: boolean;
    riskPass: boolean;
    reasoning: string[];
  };
  supportsShort: boolean;
  shortSuppressed: boolean;
  finalSignal: string;
  hasSignal: boolean;
  exactRejectionGate: RejectionGate;
  rejectionExplanation: string;
}

export interface EvaluationResult {
  strategyId: string;
  timestamp: number;
  confidenceScore: number;
  hasSignal: boolean;
  metadata: {
    reasoning: string[];
    forensicTrace?: ForensicTrace;
    [key: string]: any;
  };
}

