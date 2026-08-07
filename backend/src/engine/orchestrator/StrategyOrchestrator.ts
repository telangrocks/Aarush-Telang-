import { EngineStateMachine } from '../state-machine/EngineStateMachine';
import { EngineState } from '../dto/EngineState';
import { StrategyContext } from '../context/StrategyContext';
import { IStrategy } from '../interfaces/IStrategy';
import { EvaluationResult } from '../dto/EvaluationResult';
import { MarketDataEngine } from '../market-data/MarketDataEngine';
import { Timeframe } from '../market-data/Timeframe';
import { StrategyRegistry } from '../strategies/StrategyRegistry';
import { MetricsEngine } from '../../telemetry/MetricsEngine';
import { StructuredLogger } from '../../infrastructure/telemetry/Telemetry';
import { OrchestratorCycleEvent, StrategyExecutionEvent, StrategyErrorEvent } from '../../telemetry/TelemetryEvents';
import { UnifiedError } from '../../exchanges/models/UnifiedError';

export class StrategyOrchestrator {
  private stateMachine: EngineStateMachine;
  private marketDataEngine: MarketDataEngine | null = null;
  private logger = new StructuredLogger();

  constructor() {
    this.stateMachine = new EngineStateMachine();
  }

  public setMarketDataEngine(engine: MarketDataEngine): void {
    this.marketDataEngine = engine;
  }

  public async executeCycle(
    symbol: string,
    strategyId?: string,
    config?: Record<string, any>,
    accountBalance: number = 1000
  ): Promise<EvaluationResult[]> {
    const cycleStart = performance.now();
    let successfulEvaluations = 0;
    let failedEvaluations = 0;
    let buySignals = 0;
    let sellSignals = 0;
    let holdSignals = 0;

    try {
      // Fix SE-3: Recovery path for ERROR state
      const currentState = this.stateMachine.getState();
      if (currentState === EngineState.ERROR) {
        this.logger.warn(`[StrategyOrchestrator] Recovering from ERROR state to INITIALIZING for cycle on ${symbol}`);
        this.stateMachine = new EngineStateMachine();
      }

      if (this.stateMachine.getState() === EngineState.INITIALIZING || this.stateMachine.getState() === EngineState.WAITING) {
        this.stateMachine.transition(EngineState.COLLECTING_DATA);
      }

      this.logger.info(`[Orchestrator] Collecting Data for ${symbol}...`);
      if (!this.marketDataEngine) {
        throw new UnifiedError('MarketDataEngine is not configured on the StrategyOrchestrator', 'UNSUPPORTED_OPERATION');
      }

      const registry = StrategyRegistry.getInstance();
      let targetTimeframes: Timeframe[] = ['15m', '1h', '4h'];
      let candleLimit = 200;

      // Fix SE-C1 & SE-C3: Resolve timeframes and candle limit dynamically based on strategies
      if (strategyId) {
        const strategy = registry.createStrategy(strategyId, config);
        // Fix SE-2: Throw error when strategyId is unregistered
        if (!strategy) {
          const availableStrats = registry.getAvailableStrategies().join(', ');
          this.logger.warn(`[StrategyOrchestrator] Strategy '${strategyId}' not found. Available: ${availableStrats}`);
          throw new UnifiedError(`Strategy '${strategyId}' is not registered.`, 'UNSUPPORTED_OPERATION');
        }
        if (strategy.manifest?.supportedTimeframes) {
          targetTimeframes = strategy.manifest.supportedTimeframes as Timeframe[];
        }
        if (strategy.manifest?.minimumCandles) {
          candleLimit = Math.max(candleLimit, strategy.manifest.minimumCandles);
        }
      } else {
        // Evaluate all strategies — union required timeframes and maximum minimumCandles
        const allManifests = registry.getAllManifests();
        const tfSet = new Set<Timeframe>();
        for (const m of allManifests) {
          if (Array.isArray(m.supportedTimeframes)) {
            m.supportedTimeframes.forEach(tf => tfSet.add(tf as Timeframe));
          }
          if (m.minimumCandles) {
            candleLimit = Math.max(candleLimit, m.minimumCandles);
          }
        }
        if (tfSet.size > 0) {
          targetTimeframes = Array.from(tfSet);
        }
      }

      const snapshot = await this.marketDataEngine.getSnapshot(symbol, targetTimeframes, candleLimit);
      
      this.stateMachine.transition(EngineState.EVALUATING);
      
      // Fix SE-C2: Pass accountBalance to StrategyContext
      const context = new StrategyContext(snapshot, accountBalance);
      const frozenContext = context.freeze();

      const results: EvaluationResult[] = [];
      const metrics = MetricsEngine.getInstance();

      const tallySignal = (result: EvaluationResult | null, success: boolean) => {
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
      };

      if (strategyId) {
        const strategy = registry.createStrategy(strategyId, config)!;
        this.logger.info(`[Orchestrator] Evaluating strategy: ${strategyId} (with config overrides)`);
        const { result, success } = this.evaluateWithTelemetry(strategy, strategyId, symbol, frozenContext);
        if (result) results.push(result);
        tallySignal(result, success);
      } else {
        for (const [id, strategy] of registry.getAllStrategies()) {
          this.logger.info(`[Orchestrator] Evaluating strategy: ${id}`);
          const { result, success } = this.evaluateWithTelemetry(strategy, id, symbol, frozenContext);
          if (result) results.push(result);
          tallySignal(result, success);
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
      this.logger.error('[Orchestrator] Fatal error during cycle execution', { symbol, error: e instanceof Error ? e.message : String(e) });
      try {
        this.stateMachine.transition(EngineState.ERROR);
      } catch (_) {}
      throw e;
    }
  }

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
      this.logger.error(`[Orchestrator] Strategy ${id} evaluation failed (${durationMs.toFixed(1)}ms):`, { id, symbol, error: e?.message ?? String(e) });

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
