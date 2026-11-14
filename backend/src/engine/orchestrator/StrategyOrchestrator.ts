import { EngineStateMachine } from '../state-machine/EngineStateMachine';
import { EngineState } from '../dto/EngineState';
import { StrategyContext } from '../context/StrategyContext';
import { IStrategy } from '../interfaces/IStrategy';
import { EvaluationResult } from '../dto/EvaluationResult';
import { MarketDataEngine } from '../market-data/MarketDataEngine';
import { MarketSnapshot } from '../market-data/MarketSnapshot';
import { Timeframe } from '../market-data/Timeframe';
import { StrategyRegistry } from '../strategies/StrategyRegistry';
import { MetricsEngine } from '../../telemetry/MetricsEngine';
import { StructuredLogger } from '../../infrastructure/telemetry/Telemetry';
import { OrchestratorCycleEvent, StrategyExecutionEvent, StrategyErrorEvent } from '../../telemetry/TelemetryEvents';
import { UnifiedError } from '../../exchanges/models/UnifiedError';
import { BackendDiagnosticSink } from '../../telemetry/BackendDiagnosticSink';

export class StrategyOrchestrator {
  private stateMachine: EngineStateMachine;
  private marketDataEngine: MarketDataEngine | null = null;
  private logger = new StructuredLogger();
  private lastSnapshot: MarketSnapshot | null = null;

  constructor() {
    this.stateMachine = new EngineStateMachine();
  }

  public setMarketDataEngine(engine: MarketDataEngine): void {
    this.marketDataEngine = engine;
  }

  public getLastSnapshot(): MarketSnapshot | null {
    return this.lastSnapshot;
  }

  public async executeCycle(
    symbol: string,
    strategyId?: string,
    config?: Record<string, any>,
    accountBalance: number = 1000,
    telemetryContext?: {
      userId: string;
      cycleId: string;
      sink?: BackendDiagnosticSink;
      isCandidateSuppressed?: (strategyId: string, timeframe: Timeframe, snapshot: MarketSnapshot) => boolean;
    }
  ): Promise<EvaluationResult[]> {
    const cycleStart = performance.now();
    let successfulEvaluations = 0;
    let failedEvaluations = 0;
    let skippedEvaluations = 0;
    let buySignals = 0;
    let sellSignals = 0;

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
      const SAFE_CANDLE_BUFFER = 2;
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
          candleLimit = Math.max(candleLimit, strategy.manifest.minimumCandles + SAFE_CANDLE_BUFFER);
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
            candleLimit = Math.max(candleLimit, m.minimumCandles + SAFE_CANDLE_BUFFER);
          }
        }
        if (tfSet.size > 0) {
          targetTimeframes = Array.from(tfSet);
        }
      }

      const snapshot = await this.marketDataEngine.getSnapshot(symbol, targetTimeframes, candleLimit);
      this.lastSnapshot = snapshot;
      
      this.stateMachine.transition(EngineState.EVALUATING);
      
      // Fix SE-C2: Pass accountBalance to StrategyContext
      const context = new StrategyContext(snapshot, accountBalance);
      const frozenContext = context.freeze();

      const results: EvaluationResult[] = [];
      const metrics = MetricsEngine.getInstance();

      const tallySignal = (result: EvaluationResult | null, success: boolean) => {
        if (success) {
          successfulEvaluations++;
          if (result?.hasSignal && result.metadata?.signal) {
            const sigType = result.metadata.signal.type;
            if (sigType === 'BUY') buySignals++;
            else if (sigType === 'SELL') sellSignals++;
          }
        } else {
          failedEvaluations++;
        }
      };

      if (strategyId) {
        const strategy = registry.createStrategy(strategyId, config)!;
        this.logger.info(`[Orchestrator] Evaluating strategy: ${strategyId} (with config overrides)`);
        for (const tf of strategy.manifest.supportedTimeframes) {
          if (telemetryContext?.isCandidateSuppressed?.(strategyId, tf as Timeframe, snapshot)) {
            skippedEvaluations++;
            continue;
          }
          const { result, success } = this.evaluateWithTelemetry(strategy, strategyId, tf, symbol, frozenContext, telemetryContext);
          if (result) results.push(result);
          tallySignal(result, success);
        }
      } else {
        const hasExplicitOverrides = Boolean(config && typeof config === 'object' && Object.keys(config).length > 0);
        const emitConfigErrorTelemetry = (stratId: string) => {
          if (telemetryContext?.userId && telemetryContext?.sink) {
            telemetryContext.sink.emit({
              userId: telemetryContext.userId,
              category: 'STRATEGY',
              component: 'StrategyOrchestrator',
              eventName: 'STRATEGY_EVALUATION',
              severity: 'ERROR',
              cycleId: telemetryContext.cycleId,
              symbol,
              strategyId: stratId,
              durationMs: 0,
              payload: {
                hasSignal: false,
                signalType: null,
                confidenceScore: 0,
                errorCode: 'INVALID_STRATEGY_CONFIG'
              }
            });
          }
        };

        for (const [id, defaultStrategy] of registry.getAllStrategies()) {
          let strategyToEvaluate: IStrategy = defaultStrategy;

          if (hasExplicitOverrides) {
            try {
              const configured = registry.createStrategy(id, config);
              if (!configured) {
                this.logger.error(`[Orchestrator] Strategy '${id}' could not be instantiated with user configuration. Suppressing evaluation.`);
                failedEvaluations++;
                emitConfigErrorTelemetry(id);
                continue;
              }
              strategyToEvaluate = configured;
            } catch (configErr: any) {
              this.logger.error(`[Orchestrator] Configuration error for strategy '${id}': ${configErr?.message || String(configErr)}. Suppressing evaluation.`);
              failedEvaluations++;
              emitConfigErrorTelemetry(id);
              continue; // Strict Live Safety: Never execute unapproved default SL/TP on explicit config failure
            }
          }

          this.logger.info(`[Orchestrator] Evaluating strategy: ${id}${hasExplicitOverrides ? ' (with config overrides)' : ''}`);
          for (const tf of strategyToEvaluate.manifest.supportedTimeframes) {
            if (telemetryContext?.isCandidateSuppressed?.(id, tf as Timeframe, snapshot)) {
              skippedEvaluations++;
              continue;
            }
            const { result, success } = this.evaluateWithTelemetry(strategyToEvaluate, id, tf, symbol, frozenContext, telemetryContext);
            if (result) results.push(result);
            tallySignal(result, success);
          }
        }
      }

      const cycleDuration = performance.now() - cycleStart;
      const cycleEvent: OrchestratorCycleEvent = {
        type: 'ORCHESTRATOR_CYCLE',
        symbol,
        totalStrategies: successfulEvaluations + failedEvaluations + skippedEvaluations,
        successfulEvaluations,
        failedEvaluations,
        skippedEvaluations,
        buySignals,
        sellSignals,
        totalDurationMs: cycleDuration,
        timestamp: Date.now()
      };
      metrics.record(cycleEvent);

      this.stateMachine.transition(EngineState.WAITING);
      
      return results;

    } catch (e) {
      this.stateMachine.transition(EngineState.ERROR);
      this.logger.error(`[Orchestrator] Cycle failed for ${symbol}:`, { error: (e as any)?.message ?? String(e) });
      throw e;
    }
  }

  private evaluateWithTelemetry(
    strategy: IStrategy,
    id: string,
    targetTimeframe: Timeframe,
    symbol: string,
    frozenContext: Readonly<StrategyContext>,
    telemetryContext?: { userId: string; cycleId: string; sink?: BackendDiagnosticSink }
  ): { result: EvaluationResult | null; success: boolean } {
    const metrics = MetricsEngine.getInstance();
    const evalStart = performance.now();

    try {
      const result = strategy.evaluate(frozenContext, targetTimeframe);
      const durationMs = performance.now() - evalStart;

      const sigType = result.hasSignal ? (result.metadata?.signal?.type ?? null) : null;
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

      // Backend Diagnostic Sink: Emit STRATEGY_EVALUATION on actionable signal (sampling/volume control)
      if (result.hasSignal && telemetryContext?.userId && telemetryContext?.sink) {
        const safeSignalType = sigType === 'BUY' || sigType === 'SELL' ? sigType : null;
        telemetryContext.sink.emit({
          userId: telemetryContext.userId,
          category: 'STRATEGY',
          component: 'StrategyOrchestrator',
          eventName: 'STRATEGY_EVALUATION',
          severity: 'INFO',
          cycleId: telemetryContext.cycleId,
          symbol,
          strategyId: id,
          durationMs,
          payload: {
            hasSignal: true,
            signalType: safeSignalType,
            confidenceScore: Math.round(result.confidenceScore || 0),
            targetTimeframe,
            errorCode: null
          }
        });
      }

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

      // Backend Diagnostic Sink: Emit STRATEGY_EVALUATION on strategy error/exception
      if (telemetryContext?.userId && telemetryContext?.sink) {
        telemetryContext.sink.emit({
          userId: telemetryContext.userId,
          category: 'STRATEGY',
          component: 'StrategyOrchestrator',
          eventName: 'STRATEGY_EVALUATION',
          severity: 'ERROR',
          cycleId: telemetryContext.cycleId,
          symbol,
          strategyId: id,
          durationMs,
          payload: {
            hasSignal: false,
            signalType: null,
            confidenceScore: 0,
            errorCode: 'STRATEGY_EVAL_EXCEPTION'
          }
        });
      }

      return { result: null, success: false };
    }
  }

  public getCurrentState(): EngineState {
    return this.stateMachine.getState();
  }
}
