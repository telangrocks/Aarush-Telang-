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
import { emitStageSpan } from '../../infrastructure/monitoring/PipelineTelemetry';

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
    accountBalance: number = 0,
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

      const md = result.metadata as Record<string, any> | undefined;
      const snap = frozenContext.marketSnapshot;
      const tfCandles = snap?.candles?.[targetTimeframe] || [];
      const minRequiredBars = strategy.manifest?.minimumCandles ?? 35;
      const insufficientBars = tfCandles.length < minRequiredBars;

      // --- Stage 4 Telemetry: target-timeframe-scoped indicator extraction ---
      // Indicators live at result.metadata.indicatorSnapshot.timeframes[targetTimeframe]
      // as keyed series arrays computed by IndicatorEngine on exclusively closed candles.
      // This block is telemetry-only and is isolated with try-catch; any failure here
      // cannot affect `result`, trading signals, or the returned EvaluationResult.
      const numOrUndef = (v: unknown): number | undefined =>
        (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;

      let taRsi: number | undefined;
      let taEma9: number | undefined;
      let taEma21: number | undefined;
      let taEma50: number | undefined;
      let taEma200: number | undefined;
      let taMacdLine: number | undefined;
      let taMacdSignal: number | undefined;
      let taMacdHist: number | undefined;
      let taAtr: number | undefined;
      let taRegime: string | undefined;

      try {
        const indicatorSnapshot = md?.indicatorSnapshot as { timeframes?: Record<string, any> } | undefined;
        const tfInd = indicatorSnapshot?.timeframes?.[targetTimeframe];
        const cfg = (strategy as any).config?.conditionConfig;

        const rsiPeriod: number = cfg?.rsiPeriod ?? 14;
        const emaFastPeriod: number = cfg?.emaFastPeriod ?? 9;
        const emaSlowPeriod: number = cfg?.emaSlowPeriod ?? 21;
        const macdKey: string = cfg?.macdKey ?? '12,26,9';
        const atrPeriod: number = cfg?.atrPeriod ?? 14;

        taRsi = numOrUndef(tfInd?.rsi?.[rsiPeriod]?.slice(-1)[0]);

        const emaFastVal = numOrUndef(tfInd?.ema?.[emaFastPeriod]?.slice(-1)[0]);
        const emaSlowVal = numOrUndef(tfInd?.ema?.[emaSlowPeriod]?.slice(-1)[0]);
        // Map computed EMA values to named dashboard fields by actual period.
        // A strategy only computes the EMAs in its indicatorConfig; unused periods
        // remain undefined and are stored as NULL (truthful ACTUAL_NULL, not fabricated).
        if (emaFastPeriod === 9   || emaSlowPeriod === 9)   taEma9   = emaFastPeriod === 9   ? emaFastVal : emaSlowVal;
        if (emaFastPeriod === 21  || emaSlowPeriod === 21)  taEma21  = emaFastPeriod === 21  ? emaFastVal : emaSlowVal;
        if (emaFastPeriod === 50  || emaSlowPeriod === 50)  taEma50  = emaFastPeriod === 50  ? emaFastVal : emaSlowVal;
        if (emaFastPeriod === 200 || emaSlowPeriod === 200) taEma200 = emaFastPeriod === 200 ? emaFastVal : emaSlowVal;

        const macdLast = tfInd?.macd?.[macdKey]?.slice(-1)[0];
        taMacdLine   = numOrUndef(macdLast?.macdLine);
        taMacdSignal = numOrUndef(macdLast?.signalLine);
        taMacdHist   = numOrUndef(macdLast?.histogram);

        taAtr = numOrUndef(tfInd?.atr?.[atrPeriod]?.slice(-1)[0]);
        taRegime = typeof md?.regime === 'string' ? md.regime : md?.regime?.regime;
      } catch {
        // Telemetry extraction failure must never propagate or affect trading evaluation.
        // All taXxx variables remain undefined → stored as NULL in D1.
      }
      // --- End Stage 4 Telemetry extraction ---

      // True when the strategy returned before computing indicators (e.g. insufficient CLOSED
      // candles after forming-candle filtering). Values stay undefined; this flag documents why.
      const indicatorsComputed = Boolean((md?.indicatorSnapshot as any)?.timeframes?.[targetTimeframe]);

      // Stage 4 emission is telemetry-only: a failure here must never convert a successful
      // strategy evaluation into a failed one or alter the returned EvaluationResult.
      try {
      if (insufficientBars) {
        emitStageSpan({
          journey: 'JOURNEY_B_AUTONOMOUS',
          cycleId: telemetryContext?.cycleId,
          userId: telemetryContext?.userId,
          stage: 4,
          tier: 'TIER_2',
          eventType: 'TA_COMPUTED',
          status: 'SKIPPED',
          severity: 'WARNING',
          symbol,
          timeframe: targetTimeframe,
          strategyId: id,
          component: 'IndicatorEngine',
          sourceFile: 'backend/src/engine/orchestrator/StrategyOrchestrator.ts',
          errorCode: 'INSUFFICIENT_BARS',
          message: `Skipped ${id} (${symbol} ${targetTimeframe}): ${tfCandles.length}/${minRequiredBars} bars`,
          inputSummary: { candlesCount: tfCandles.length, minRequiredBars, indicatorEngine: 'CANONICAL' },
          outputSummary: { timeframe: targetTimeframe, indicatorEngine: 'CANONICAL', skipReason: 'INSUFFICIENT_BARS' },
        });
      } else {
        emitStageSpan({
          journey: 'JOURNEY_B_AUTONOMOUS',
          cycleId: telemetryContext?.cycleId,
          userId: telemetryContext?.userId,
          stage: 4,
          tier: 'TIER_2',
          eventType: 'TA_COMPUTED',
          status: 'PASS',
          severity: 'INFO',
          symbol,
          timeframe: targetTimeframe,
          strategyId: id,
          component: 'IndicatorEngine',
          sourceFile: 'backend/src/engine/orchestrator/StrategyOrchestrator.ts',
          durationMs,
          message: `Computed canonical TA for ${symbol} ${targetTimeframe} (${tfCandles.length} bars)`,
          inputSummary: { candlesCount: tfCandles.length, minRequiredBars, indicatorEngine: 'CANONICAL' },
          outputSummary: {
            timeframe:      targetTimeframe,
            indicatorEngine: 'CANONICAL',
            // Explicit null (not undefined) when the strategy did not compute / could not produce a
            // finite value: JSON drops undefined keys, which the monitoring API would misreport as
            // UNAVAILABLE_IN_TELEMETRY. Explicit null is reported as ACTUAL_NULL (producer evaluated).
            rsi:        taRsi ?? null,
            ema9:       taEma9 ?? null,
            ema21:      taEma21 ?? null,
            ema50:      taEma50 ?? null,
            ema200:     taEma200 ?? null,
            macdLine:   taMacdLine ?? null,
            macdSignal: taMacdSignal ?? null,
            macdHist:   taMacdHist ?? null,
            atr:        taAtr ?? null,
            regime:     taRegime,
            confidenceScore: result.confidenceScore,
            ...(indicatorsComputed ? {} : { indicatorsUnavailableReason: 'STRATEGY_REJECTED_BEFORE_INDICATORS' }),
          },
        });
      }
      } catch {
        // Swallow: telemetry must not affect evaluation, signals or returned results.
      }

      emitStageSpan({
        journey: 'JOURNEY_B_AUTONOMOUS',
        cycleId: telemetryContext?.cycleId,
        userId: telemetryContext?.userId,
        stage: 5,
        tier: result.hasSignal ? 'TIER_1' : 'TIER_3',
        eventType: result.hasSignal ? 'SIGNAL_DETECTED' : 'STRATEGY_EVALUATED',
        status: 'PASS',
        severity: 'INFO',
        symbol,
        timeframe: targetTimeframe,
        strategyId: id,
        component: 'StrategyOrchestrator',
        sourceFile: 'backend/src/engine/orchestrator/StrategyOrchestrator.ts',
        durationMs,
        message: result.hasSignal
          ? `Strategy ${id} generated ${sigType} signal on ${symbol} ${targetTimeframe} (score=${Math.round(result.confidenceScore || 0)})`
          : `Evaluated ${id} on ${symbol} ${targetTimeframe}: no signal`,
        outputSummary: {
          hasSignal: result.hasSignal,
          signalGenerated: result.hasSignal,
          side: sigType,
          confidenceScore: result.confidenceScore,
          gateCategory: 'STRATEGY',
          decision: result.hasSignal ? 'ALLOW' : 'SKIPPED',
          reason: result.hasSignal ? `Signal ${sigType}` : 'NO_SIGNAL_CRITERIA_MET',
        },
      });

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
