/**
 * TelemetryEvents.ts
 *
 * Defines the canonical telemetry event types for the Strategy Platform.
 * The telemetry layer is completely independent of trading decisions.
 * It collects operational metrics only — it never modifies any evaluation result.
 */

export type SignalType = 'BUY' | 'SELL' | 'HOLD';
export type RiskClassification = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' | 'UNKNOWN';

/**
 * Emitted once per strategy evaluation call.
 */
export interface StrategyExecutionEvent {
  type: 'STRATEGY_EXECUTION';
  strategyId: string;
  symbol: string;
  durationMs: number;
  hasSignal: boolean;
  signal: SignalType | null;
  confidenceScore: number;
  riskClassification: RiskClassification;
  timestamp: number;
}

/**
 * Emitted when a strategy throws an unhandled exception during evaluate().
 */
export interface StrategyErrorEvent {
  type: 'STRATEGY_ERROR';
  strategyId: string;
  symbol: string;
  error: string;
  timestamp: number;
}

/**
 * Emitted when a full orchestrator cycle completes (all strategies evaluated).
 */
export interface OrchestratorCycleEvent {
  type: 'ORCHESTRATOR_CYCLE';
  symbol: string;
  totalStrategies: number;
  successfulEvaluations: number;
  failedEvaluations: number;
  skippedEvaluations: number;
  buySignals: number;
  sellSignals: number;
  holdSignals: number;
  totalDurationMs: number;
  timestamp: number;
}

/**
 * Emitted when market data is malformed or invalid.
 */
export interface MalformedDataEvent {
  type: 'MALFORMED_DATA';
  symbol: string;
  reason: string;
  timestamp: number;
}

/**
 * Emitted when data collection from the exchange times out.
 */
export interface TimeoutEvent {
  type: 'TIMEOUT';
  symbol: string;
  operationType: 'DATA_FETCH' | 'STRATEGY_EVAL';
  durationMs: number;
  timestamp: number;
}

/**
 * Union of all telemetry event types.
 */
export type TelemetryEvent =
  | StrategyExecutionEvent
  | StrategyErrorEvent
  | OrchestratorCycleEvent
  | MalformedDataEvent
  | TimeoutEvent;
