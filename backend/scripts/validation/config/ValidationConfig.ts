/**
 * Production Validation Framework — Configurable SLA Thresholds
 */

export interface ValidationSlaConfig {
  maxWorkerLatencyMs: number;
  maxDbLatencyMs: number;
  maxExchangeApiLatencyMs: number;
  maxKlineFetchLatencyMs: number;
  maxStrategyEvaluationLatencyMs: number;
  maxRiskCalculationLatencyMs: number;
  maxOrderExecutionLatencyMs: number;
  maxRecoveryLatencyMs: number;
  maxNotificationLatencyMs: number;
  maxClockDriftMs: number;
  maxMemoryUsageMb: number;
  maxKlineStaleAgeSeconds: number;
}

export const DEFAULT_VALIDATION_CONFIG: ValidationSlaConfig = {
  maxWorkerLatencyMs: parseInt(process.env.SLA_WORKER_LATENCY_MS || "5000", 10),
  maxDbLatencyMs: parseInt(process.env.SLA_DB_LATENCY_MS || "10000", 10),
  maxExchangeApiLatencyMs: parseInt(process.env.SLA_EXCHANGE_API_LATENCY_MS || "3000", 10),
  maxKlineFetchLatencyMs: parseInt(process.env.SLA_KLINE_FETCH_LATENCY_MS || "8000", 10),
  maxStrategyEvaluationLatencyMs: parseInt(process.env.SLA_STRATEGY_EVAL_LATENCY_MS || "50", 10),
  maxRiskCalculationLatencyMs: parseInt(process.env.SLA_RISK_CALC_LATENCY_MS || "20", 10),
  maxOrderExecutionLatencyMs: parseInt(process.env.SLA_ORDER_EXEC_LATENCY_MS || "3000", 10),
  maxRecoveryLatencyMs: parseInt(process.env.SLA_RECOVERY_LATENCY_MS || "3000", 10),
  maxNotificationLatencyMs: parseInt(process.env.SLA_NOTIFICATION_LATENCY_MS || "1000", 10),
  maxClockDriftMs: parseInt(process.env.SLA_MAX_CLOCK_DRIFT_MS || "5000", 10),
  maxMemoryUsageMb: parseInt(process.env.SLA_MAX_MEMORY_MB || "512", 10),
  maxKlineStaleAgeSeconds: parseInt(process.env.SLA_MAX_KLINE_STALE_AGE_SEC || "60", 10),
};
