/**
 * MetricsEngine.ts
 *
 * Collects, aggregates, and exposes operational metrics for the Strategy Platform.
 * This engine is entirely passive — it observes and records; it never modifies
 * any trading decision, evaluation result, or engine state.
 */

import {
  TelemetryEvent,
  StrategyExecutionEvent,
  StrategyErrorEvent,
  OrchestratorCycleEvent,
  MalformedDataEvent,
  TimeoutEvent
} from './TelemetryEvents';

export interface StrategyMetricsSummary {
  strategyId: string;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  buySignals: number;
  sellSignals: number;
  holdSignals: number;
  avgDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
  avgConfidenceScore: number;
}

export interface SystemMetricsSummary {
  totalCycles: number;
  totalEvaluations: number;
  totalErrors: number;
  totalTimeouts: number;
  totalMalformedDataEvents: number;
  strategyMetrics: Record<string, StrategyMetricsSummary>;
  uptime: number; // ms since MetricsEngine was reset
  lastCycleAt: number | null;
}

export class MetricsEngine {
  private static instance: MetricsEngine;
  private events: TelemetryEvent[] = [];
  private strategyStats: Map<string, StrategyMetricsSummary> = new Map();
  private cycleCount = 0;
  private errorCount = 0;
  private timeoutCount = 0;
  private malformedDataCount = 0;
  private startTime: number = Date.now();
  private lastCycleAt: number | null = null;

  private constructor() {}

  public static getInstance(): MetricsEngine {
    if (!MetricsEngine.instance) {
      MetricsEngine.instance = new MetricsEngine();
    }
    return MetricsEngine.instance;
  }

  /** Reset all metrics (useful between test runs). */
  public reset(): void {
    this.events = [];
    this.strategyStats = new Map();
    this.cycleCount = 0;
    this.errorCount = 0;
    this.timeoutCount = 0;
    this.malformedDataCount = 0;
    this.startTime = Date.now();
    this.lastCycleAt = null;
  }

  /** Record any telemetry event. The event is stored and metrics are updated. */
  public record(event: TelemetryEvent): void {
    // Keep the last 1000 events in memory to avoid unbounded growth
    if (this.events.length >= 1000) {
      this.events.shift();
    }
    this.events.push(event);

    switch (event.type) {
      case 'STRATEGY_EXECUTION':
        this.updateStrategyMetrics(event);
        break;
      case 'STRATEGY_ERROR':
        this.errorCount++;
        this.ensureStrategyEntry(event.strategyId);
        this.strategyStats.get(event.strategyId)!.failedExecutions++;
        break;
      case 'ORCHESTRATOR_CYCLE':
        this.cycleCount++;
        this.lastCycleAt = event.timestamp;
        break;
      case 'TIMEOUT':
        this.timeoutCount++;
        break;
      case 'MALFORMED_DATA':
        this.malformedDataCount++;
        break;
    }
  }

  private ensureStrategyEntry(strategyId: string): void {
    if (!this.strategyStats.has(strategyId)) {
      this.strategyStats.set(strategyId, {
        strategyId,
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        buySignals: 0,
        sellSignals: 0,
        holdSignals: 0,
        avgDurationMs: 0,
        maxDurationMs: 0,
        minDurationMs: Infinity,
        avgConfidenceScore: 0
      });
    }
  }

  private updateStrategyMetrics(event: StrategyExecutionEvent): void {
    this.ensureStrategyEntry(event.strategyId);
    const s = this.strategyStats.get(event.strategyId)!;

    s.totalExecutions++;
    s.successfulExecutions++;

    if (event.signal === 'BUY') s.buySignals++;
    else if (event.signal === 'SELL') s.sellSignals++;
    else s.holdSignals++;

    // Running average using Welford's online algorithm
    const n = s.totalExecutions;
    s.avgDurationMs = s.avgDurationMs + (event.durationMs - s.avgDurationMs) / n;
    s.avgConfidenceScore = s.avgConfidenceScore + (event.confidenceScore - s.avgConfidenceScore) / n;

    if (event.durationMs > s.maxDurationMs) s.maxDurationMs = event.durationMs;
    if (event.durationMs < s.minDurationMs) s.minDurationMs = event.durationMs;
  }

  /** Returns the current system-wide metrics summary. */
  public getSummary(): SystemMetricsSummary {
    const strategyMetrics: Record<string, StrategyMetricsSummary> = {};
    for (const [id, summary] of this.strategyStats) {
      strategyMetrics[id] = { ...summary };
    }

    return {
      totalCycles: this.cycleCount,
      totalEvaluations: Array.from(this.strategyStats.values()).reduce((sum, s) => sum + s.totalExecutions, 0),
      totalErrors: this.errorCount,
      totalTimeouts: this.timeoutCount,
      totalMalformedDataEvents: this.malformedDataCount,
      strategyMetrics,
      uptime: Date.now() - this.startTime,
      lastCycleAt: this.lastCycleAt
    };
  }

  /** Returns the last N raw telemetry events for debugging/review. */
  public getRecentEvents(count: number = 50): TelemetryEvent[] {
    return this.events.slice(-count);
  }

  /** Logs the current summary to the console. */
  public logSummary(): void {
    const summary = this.getSummary();
    console.log('[MetricsEngine] System Summary:', JSON.stringify(summary, null, 2));
  }
}
