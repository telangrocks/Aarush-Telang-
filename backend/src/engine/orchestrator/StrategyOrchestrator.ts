import { EngineStateMachine } from '../state-machine/EngineStateMachine';
import { EngineState } from '../dto/EngineState';
import { StrategyContext } from '../context/StrategyContext';
import { IStrategy } from '../interfaces/IStrategy';
import { EvaluationResult } from '../dto/EvaluationResult';
import { MarketDataEngine } from '../market-data/MarketDataEngine';
import { Timeframe } from '../market-data/Timeframe';
import { StrategyRegistry } from '../strategies/StrategyRegistry';
import { MetricsEngine } from '../../telemetry/MetricsEngine';
import { OrchestratorCycleEvent, StrategyExecutionEvent, StrategyErrorEvent } from '../../telemetry/TelemetryEvents';

export class StrategyOrchestrator {
  private stateMachine: EngineStateMachine;
  private marketDataEngine: MarketDataEngine | null = null;
  private requiredTimeframes: Timeframe[] = ['5m', '15m', '1h']; // Configurable based on strategies later

  constructor() {
    this.stateMachine = new EngineStateMachine();
  }

  public setMarketDataEngine(engine: MarketDataEngine): void {
    this.marketDataEngine = engine;
  }

  public async executeCycle(symbol: string, strategyId?: string, config?: any): Promise<EvaluationResult[]> {
    const cycleStart = performance.now();
    let successfulEvaluations = 0;
    let failedEvaluations = 0;
    let buySignals = 0;
    let sellSignals = 0;
    let holdSignals = 0;

    try {
      if (this.stateMachine.getState() === EngineState.INITIALIZING || this.stateMachine.getState() === EngineState.WAITING) {
        this.stateMachine.transition(EngineState.COLLECTING_DATA);
      }

      console.log('[Orchestrator] Collecting Data...');
      if (!this.marketDataEngine) {
        throw new Error('MarketDataEngine is not configured on the StrategyOrchestrator');
      }

      const snapshot = await this.marketDataEngine.getSnapshot(symbol, this.requiredTimeframes);
      
      this.stateMachine.transition(EngineState.EVALUATING);
      
      const context = new StrategyContext(snapshot);
      const frozenContext = context.freeze();

      const results: EvaluationResult[] = [];
      const registry = StrategyRegistry.getInstance();
      const metrics = MetricsEngine.getInstance();
      
      if (strategyId) {
        const strategy = registry.createStrategy(strategyId, config);
        if (strategy) {
          console.log(`[Orchestrator] Evaluating strategy: ${strategyId} (with config overrides)`);
          const { result, success } = this.evaluateWithTelemetry(strategy, strategyId, symbol, frozenContext);
          if (result) results.push(result);
          if (success) {
            successfulEvaluations++;
            if (result?.hasSignal) {
              const sigType = result.metadata?.signal?.type;
              if (sigType === 'BUY') buySignals++;
              else if (sigType === 'SELL') sellSignals++;
              else holdSignals++;
            } else {
              holdSignals++;
            }
          } else {
            failedEvaluations++;
          }
        }
      } else {
        for (const [id, strategy] of registry.getAllStrategies()) {
          console.log(`[Orchestrator] Evaluating strategy: ${id}`);
          const { result, success } = this.evaluateWithTelemetry(strategy, id, symbol, frozenContext);
          if (result) results.push(result);
          if (success) {
            successfulEvaluations++;
            if (result?.hasSignal) {
              const sigType = result.metadata?.signal?.type;
              if (sigType === 'BUY') buySignals++;
              else if (sigType === 'SELL') sellSignals++;
              else holdSignals++;
            } else {
              holdSignals++;
            }
          } else {
            failedEvaluations++;
          }
        }
      }

      const cycleDuration = performance.now() - cycleStart;
      const cycleEvent: OrchestratorCycleEvent = {
        type: 'ORCHESTRATOR_CYCLE',
        symbol,
        totalStrategies: successfulEvaluations + failedEvaluations,
        successfulEvaluations,
        failedEvaluations,
        skippedEvaluations: 0,
        buySignals,
        sellSignals,
        holdSignals,
        totalDurationMs: cycleDuration,
        timestamp: Date.now()
      };
      metrics.record(cycleEvent);

      this.stateMachine.transition(EngineState.WAITING);
      
      return results;

    } catch (e) {
      console.error('[Orchestrator] Fatal error during cycle execution', e);
      this.stateMachine.transition(EngineState.ERROR);
      throw e;
    }
  }

  /**
   * Wraps a single strategy evaluation with timing and telemetry.
   * Ensures that a failure in one plugin never propagates to terminate the pipeline.
   * No trading logic is altered — this is purely observability wrapping.
   */
  private evaluateWithTelemetry(
    strategy: IStrategy,
    id: string,
    symbol: string,
    frozenContext: Readonly<StrategyContext>
  ): { result: EvaluationResult | null; success: boolean } {
    const metrics = MetricsEngine.getInstance();
    const evalStart = performance.now();

    try {
      const result = strategy.evaluate(frozenContext);
      const durationMs = performance.now() - evalStart;

      const sigType = result.hasSignal ? (result.metadata?.signal?.type ?? null) : 'HOLD';
      const event: StrategyExecutionEvent = {
        type: 'STRATEGY_EXECUTION',
        strategyId: id,
        symbol,
        durationMs,
        hasSignal: result.hasSignal,
        signal: sigType as any,
        confidenceScore: result.confidenceScore,
        riskClassification: 'UNKNOWN',
        timestamp: Date.now()
      };
      metrics.record(event);

      return { result, success: true };
    } catch (e: any) {
      const durationMs = performance.now() - evalStart;
      console.error(`[Orchestrator] Strategy ${id} evaluation failed (${durationMs.toFixed(1)}ms):`, e);

      const errorEvent: StrategyErrorEvent = {
        type: 'STRATEGY_ERROR',
        strategyId: id,
        symbol,
        error: e?.message ?? String(e),
        timestamp: Date.now()
      };
      metrics.record(errorEvent);

      return { result: null, success: false };
    }
  }

  public getCurrentState(): EngineState {
    return this.stateMachine.getState();
  }
}
