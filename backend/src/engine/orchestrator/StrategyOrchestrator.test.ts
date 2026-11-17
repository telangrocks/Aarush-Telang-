import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrategyOrchestrator } from './StrategyOrchestrator';
import { StrategyContext } from '../context/StrategyContext';
import { MarketDataEngine } from '../market-data/MarketDataEngine';
import { StrategyRegistry } from '../strategies/StrategyRegistry';
import { ICandleProvider } from '../../infrastructure/exchange/types';
import { BackendDiagnosticSink } from '../../telemetry/BackendDiagnosticSink';
import { Timeframe } from '../market-data/Timeframe';
import * as PipelineTelemetry from '../../infrastructure/monitoring/PipelineTelemetry';

// Module-level mock for Stage 4 telemetry tests — must be declared at module scope.
vi.mock('../../infrastructure/monitoring/PipelineTelemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof PipelineTelemetry>();
  return { ...actual, emitStageSpan: vi.fn() };
});

function createMockCandles(count = 50, basePrice = 100) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    timestamp: now - (count - i) * 300000,
    openTime: now - (count - i) * 300000,
    open: basePrice + i * 0.5,
    high: basePrice + i * 0.5 + 2,
    low: basePrice + i * 0.5 - 2,
    close: basePrice + i * 0.5 + 1,
    volume: 1000 + i * 10
  }));
}

describe('StrategyOrchestrator — Multi-Strategy Autonomous Risk Configuration Propagation', () => {
  let orchestrator: StrategyOrchestrator;
  let mockProvider: ICandleProvider;
  let dataEngine: MarketDataEngine;
  let registry: StrategyRegistry;

  beforeEach(() => {
    registry = StrategyRegistry.getInstance();
    registry.clearCache();

    mockProvider = {
      fetchTicker: vi.fn().mockResolvedValue({
        symbol: 'BTCUSDT',
        last: 50000,
        bid: 49990,
        ask: 50010,
        high: 51000,
        low: 49000,
        volume: 1000,
        quoteVolume: 50000000,
        timestamp: Date.now()
      }),
      fetchCandles: vi.fn().mockImplementation(async (_symbol: string, _tf: string, limit?: number) => {
        return createMockCandles(limit || 200, 50000);
      })
    };

    dataEngine = new MarketDataEngine(mockProvider);
    orchestrator = new StrategyOrchestrator();
    orchestrator.setMarketDataEngine(dataEngine);
  });

  it('1. propagates explicit risk parameters to all five strategies in multi-strategy execution', async () => {
    const config = {
      riskParameters: {
        atrTakeProfitMultiplier: 3.5,
        atrStopLossMultiplier: 2.2
      }
    };

    const results = await orchestrator.executeCycle('BTCUSDT', undefined, config, 1000);

    expect(results.length).toBeGreaterThan(0);

    // Group evaluation results by strategyId
    const evaluatedStrategies = new Set(results.map(r => r.strategyId));
    expect(evaluatedStrategies).toContain('ScalperV2');
    expect(evaluatedStrategies).toContain('Momentum');
    expect(evaluatedStrategies).toContain('Breakout');
    expect(evaluatedStrategies).toContain('MeanReversion');
    expect(evaluatedStrategies).toContain('VWAP');

    // Confirm every result metadata has strategyConfig reflecting the overridden risk parameters
    for (const r of results) {
      const stratConfig = r.metadata?.strategyConfig;
      expect(stratConfig).toBeDefined();
      expect(stratConfig.riskParameters.atrTakeProfitMultiplier).toBe(3.5);
      expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(2.2);
    }
  });

  it('2. preserves strategy-specific defaults when individual risk parameters are omitted', async () => {
    // Only override Take Profit multiplier, omitting Stop Loss multiplier
    const config = {
      riskParameters: {
        atrTakeProfitMultiplier: 4.0
      }
    };

    const results = await orchestrator.executeCycle('BTCUSDT', undefined, config, 1000);
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      const stratConfig = r.metadata?.strategyConfig;
      expect(stratConfig.riskParameters.atrTakeProfitMultiplier).toBe(4.0);

      // Verify that each strategy preserved its own unique default Stop Loss multiplier
      switch (r.strategyId) {
        case 'ScalperV2':
          expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(1.5);
          break;
        case 'Momentum':
          expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(2.0);
          break;
        case 'Breakout':
          expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(2.0);
          break;
        case 'MeanReversion':
          expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(1.2);
          break;
        case 'VWAP':
          expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(1.5);
          break;
      }
    }
  });

  it('3. strictly preserves maxExposureLimit from strategy defaults despite user overrides', async () => {
    const config = {
      riskParameters: {
        atrTakeProfitMultiplier: 2.5,
        atrStopLossMultiplier: 1.8,
        maxExposureLimit: 99.0 // Attempt to override system-controlled limit
      }
    };

    const results = await orchestrator.executeCycle('BTCUSDT', undefined, config, 1000);

    for (const r of results) {
      const stratConfig = r.metadata?.strategyConfig;
      switch (r.strategyId) {
        case 'ScalperV2':
          expect(stratConfig.riskParameters.maxExposureLimit).toBe(20.0);
          break;
        case 'Momentum':
          expect(stratConfig.riskParameters.maxExposureLimit).toBe(30.0);
          break;
        case 'Breakout':
          expect(stratConfig.riskParameters.maxExposureLimit).toBe(20.0);
          break;
        case 'MeanReversion':
          expect(stratConfig.riskParameters.maxExposureLimit).toBe(10.0);
          break;
        case 'VWAP':
          expect(stratConfig.riskParameters.maxExposureLimit).toBe(20.0);
          break;
      }
    }
  });

  it('4. strictly suppresses strategy evaluation on invalid configuration instead of silently falling back to defaults', async () => {
    const mockSink = {
      emit: vi.fn(),
      flush: vi.fn()
    } as unknown as BackendDiagnosticSink;

    // Invalid bounds: atrTakeProfitMultiplier = 0.2 (must be >= 1.0)
    const invalidConfig = {
      riskParameters: {
        atrTakeProfitMultiplier: 0.2
      }
    };

    const results = await orchestrator.executeCycle('BTCUSDT', undefined, invalidConfig, 1000, {
      userId: 'test_user_safety',
      cycleId: 'cycle_err_test',
      sink: mockSink
    });

    // Zero strategies should have run with fallback defaults — all evaluations suppressed
    expect(results.length).toBe(0);

    // Verify diagnostic telemetry emitted for suppression
    expect(mockSink.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'STRATEGY',
        eventName: 'STRATEGY_EVALUATION',
        severity: 'ERROR',
        payload: expect.objectContaining({
          errorCode: 'INVALID_STRATEGY_CONFIG'
        })
      })
    );
  });

  it('5. evaluates un-overridden static defaults when config is absent or empty', async () => {
    // Un-overridden baseline (undefined config)
    const results = await orchestrator.executeCycle('BTCUSDT', undefined, undefined, 1000);

    expect(results.length).toBeGreaterThan(0);
    const evaluatedStrategies = new Set(results.map(r => r.strategyId));
    expect(evaluatedStrategies.size).toBe(5);

    // Verify defaults
    for (const r of results) {
      const stratConfig = r.metadata?.strategyConfig;
      switch (r.strategyId) {
        case 'ScalperV2':
          expect(stratConfig.riskParameters.atrTakeProfitMultiplier).toBe(2.0);
          expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(1.5);
          break;
        case 'Momentum':
          expect(stratConfig.riskParameters.atrTakeProfitMultiplier).toBe(2.5);
          expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(2.0);
          break;
        case 'Breakout':
          expect(stratConfig.riskParameters.atrTakeProfitMultiplier).toBe(3.0);
          expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(2.0);
          break;
        case 'MeanReversion':
          expect(stratConfig.riskParameters.atrTakeProfitMultiplier).toBe(2.5);
          expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(1.2);
          break;
        case 'VWAP':
          expect(stratConfig.riskParameters.atrTakeProfitMultiplier).toBe(2.0);
          expect(stratConfig.riskParameters.atrStopLossMultiplier).toBe(1.5);
          break;
      }
    }
  });

  it('6. ensures StrategyRegistry static default instances remain pristine and unmutated', async () => {
    // Run cycle with aggressive overrides
    await orchestrator.executeCycle('BTCUSDT', undefined, {
      riskParameters: {
        atrTakeProfitMultiplier: 4.8,
        atrStopLossMultiplier: 4.2
      }
    }, 1000);

    // Inspect static defaults from registry directly
    const defaultScalper = registry.getStrategy('ScalperV2');
    expect((defaultScalper as any).config.riskParameters.atrTakeProfitMultiplier).toBe(2.0);
    expect((defaultScalper as any).config.riskParameters.atrStopLossMultiplier).toBe(1.5);

    const defaultMomentum = registry.getStrategy('Momentum');
    expect((defaultMomentum as any).config.riskParameters.atrTakeProfitMultiplier).toBe(2.5);
    expect((defaultMomentum as any).config.riskParameters.atrStopLossMultiplier).toBe(2.0);

    const defaultMeanReversion = registry.getStrategy('MeanReversion');
    expect((defaultMeanReversion as any).config.riskParameters.atrTakeProfitMultiplier).toBe(2.5);
    expect((defaultMeanReversion as any).config.riskParameters.atrStopLossMultiplier).toBe(1.2);
  });

  it('7. StrategyContext and StrategyOrchestrator default missing, zero, negative, or non-finite wallet balance to 0 instead of 1000', async () => {
    const mockSnapshot = {
      symbol: 'BTCUSDT',
      timestamp: Date.now(),
      currentPrice: 50000,
      volume24h: 1000,
      quoteVolume24h: 50000000,
      metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 51000, lowPrice24h: 49000 },
      candles: { '5m': [], '15m': [], '1h': [], '4h': [] }
    } as any;

    expect(new StrategyContext(mockSnapshot).accountBalance).toBe(0);
    expect(new StrategyContext(mockSnapshot, undefined).accountBalance).toBe(0);
    expect(new StrategyContext(mockSnapshot, 0).accountBalance).toBe(0);
    expect(new StrategyContext(mockSnapshot, -250).accountBalance).toBe(0);
    expect(new StrategyContext(mockSnapshot, Number.NaN).accountBalance).toBe(0);
    expect(new StrategyContext(mockSnapshot, Number.POSITIVE_INFINITY).accountBalance).toBe(0);
    expect(new StrategyContext(mockSnapshot, 2500).accountBalance).toBe(2500);

    const omittedBalResults = await orchestrator.executeCycle('BTCUSDT', undefined, undefined);
    expect(omittedBalResults.length).toBeGreaterThan(0);
    expect(new Set(omittedBalResults.map(r => r.strategyId)).size).toBe(5);
    for (const r of omittedBalResults) {
      if (r.metadata.signal) {
        expect(r.metadata.signal.riskAssessment.positionSizeRecommendation).toBe(0);
        expect(r.metadata.signal.riskAssessment.maximumExposure).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 4 — Indicator Telemetry: target-timeframe-scoped extraction tests
// ---------------------------------------------------------------------------
describe('StrategyOrchestrator — Stage 4 Indicator Telemetry Extraction', () => {
  let orchestrator: StrategyOrchestrator;
  let mockProvider: ICandleProvider;
  let dataEngine: MarketDataEngine;
  // emitStageSpan is module-mocked above; cast for typed .mock access
  const emitMock = () => PipelineTelemetry.emitStageSpan as unknown as ReturnType<typeof vi.fn>;

  // 220 closed candles — enough warm-up for EMA-200, RSI-14, ATR-14, MACD-26
  function createClosedCandles(count = 220, basePrice = 50000) {
    const now = Date.now();
    return Array.from({ length: count }, (_, i) => ({
      timestamp: now - (count - i) * 15 * 60 * 1000,
      openTime:  now - (count - i) * 15 * 60 * 1000,
      open:    basePrice + i * 10,
      high:    basePrice + i * 10 + 50,
      low:     basePrice + i * 10 - 50,
      close:   basePrice + i * 10 + 20,
      volume:  1000 + i * 5,
    }));
  }

  beforeEach(() => {
    const registry = StrategyRegistry.getInstance();
    registry.clearCache();

    mockProvider = {
      fetchTicker: vi.fn().mockResolvedValue({
        symbol: 'BTCUSDT', last: 50000, bid: 49990, ask: 50010,
        high: 51000, low: 49000, volume: 1000, quoteVolume: 50000000, timestamp: Date.now(),
      }),
      fetchCandles: vi.fn().mockImplementation(async (_symbol: string, _tf: string, limit?: number) => {
        return createClosedCandles(limit || 220, 50000);
      }),
    };

    dataEngine = new MarketDataEngine(mockProvider);
    orchestrator = new StrategyOrchestrator();
    orchestrator.setMarketDataEngine(dataEngine);

    // Reset the module-level mock before each test
    emitMock().mockClear();
    emitMock().mockImplementation(() => {});
  });

  /**
   * T1: PASS row — all five strategies must emit Stage 4 TA_COMPUTED with
   * rsi, atr, macdLine, macdSignal, macdHist present as finite numbers,
   * and at least one of ema9/ema21/ema50/ema200 populated per strategy.
   */
  it('T1: PASS TA_COMPUTED emits finite RSI, MACD and ATR for all five strategies', async () => {
    const telemetryCtx = { userId: 'test_user', cycleId: 'cycle_t1', sink: undefined as any };
    await orchestrator.executeCycle('BTCUSDT', undefined, undefined, 1000, telemetryCtx);

    const stage4PassCalls = emitMock().mock.calls
      .map((args: any[]) => args[0] as any)
      .filter((ev: any) => ev.stage === 4 && ev.status === 'PASS' && !ev.outputSummary.indicatorsUnavailableReason);

    // 5 strategies × their supported timeframes — expect at least 5 PASS spans
    expect(stage4PassCalls.length).toBeGreaterThanOrEqual(5);

    for (const ev of stage4PassCalls) {
      const out = ev.outputSummary;
      expect(out.indicatorEngine).toBe('CANONICAL');
      expect(typeof out.rsi).toBe('number');
      expect(Number.isFinite(out.rsi)).toBe(true);
      expect(out.rsi).toBeGreaterThanOrEqual(0);
      expect(out.rsi).toBeLessThanOrEqual(100);
      expect(typeof out.atr).toBe('number');
      expect(Number.isFinite(out.atr)).toBe(true);
      expect(out.atr).toBeGreaterThan(0);
      expect(Number.isFinite(out.macdLine)).toBe(true);
      expect(Number.isFinite(out.macdSignal)).toBe(true);
      expect(Number.isFinite(out.macdHist)).toBe(true);
      const emaFields = [out.ema9, out.ema21, out.ema50, out.ema200].filter((v: unknown) => typeof v === 'number');
      expect(emaFields.length).toBeGreaterThan(0);
      expect(typeof out.confidenceScore).toBe('number');
    }
  });

  /**
   * T2: SKIPPED row — insufficient candles → outputSummary must contain
   * NO numeric indicator fields (anti-fabrication guarantee).
   */
  it('T2: SKIPPED TA_COMPUTED emits no numeric indicator fields (anti-fabrication)', async () => {
    (mockProvider.fetchCandles as ReturnType<typeof vi.fn>).mockResolvedValue(
      createClosedCandles(10, 50000)
    );

    const telemetryCtx = { userId: 'test_user', cycleId: 'cycle_t2', sink: undefined as any };
    await orchestrator.executeCycle('BTCUSDT', undefined, undefined, 1000, telemetryCtx);

    const stage4Skipped = emitMock().mock.calls
      .map((args: any[]) => args[0] as any)
      .filter((ev: any) => ev.stage === 4 && ev.status === 'SKIPPED');

    expect(stage4Skipped.length).toBeGreaterThan(0);
    const numericIndicatorKeys = ['rsi', 'ema9', 'ema21', 'ema50', 'ema200', 'macdLine', 'macdSignal', 'macdHist', 'atr'];
    for (const ev of stage4Skipped) {
      const out = ev.outputSummary;
      for (const key of numericIndicatorKeys) {
        expect(out[key], `SKIPPED outputSummary.${key} must not be a number`).not.toEqual(expect.any(Number));
      }
      expect(out.skipReason).toBe('INSUFFICIENT_BARS');
    }
  });

  /**
   * T3: indicators still populated regardless of hasSignal outcome.
   */
  it('T3: indicators populated in outputSummary even when strategy returns hasSignal:false', async () => {
    const telemetryCtx = { userId: 'test_user', cycleId: 'cycle_t3', sink: undefined as any };
    await orchestrator.executeCycle('BTCUSDT', undefined, undefined, 1000, telemetryCtx);

    const stage4Pass = emitMock().mock.calls
      .map((args: any[]) => args[0] as any)
      .filter((ev: any) => ev.stage === 4 && ev.status === 'PASS' && !ev.outputSummary.indicatorsUnavailableReason);

    expect(stage4Pass.length).toBeGreaterThan(0);
    // Includes evaluations with hasSignal:false (the common case on the synthetic series)
    const stage5NoSignal = emitMock().mock.calls
      .map((args: any[]) => args[0] as any)
      .filter((ev: any) => ev.stage === 5 && ev.outputSummary?.hasSignal === false);
    expect(stage5NoSignal.length).toBeGreaterThan(0);
    for (const ev of stage4Pass) {
      expect(typeof ev.outputSummary.rsi).toBe('number');
    }
  });

  /**
   * T4: ScalperV2 — ema9 and ema21 populated; ema50/ema200 absent (undefined).
   */
  it('T4: ScalperV2 ema9/ema21 populated; ema50/ema200 absent', async () => {
    const telemetryCtx = { userId: 'test_user', cycleId: 'cycle_t4', sink: undefined as any };
    await orchestrator.executeCycle('BTCUSDT', 'ScalperV2', undefined, 1000, telemetryCtx);

    const scalperPass = emitMock().mock.calls
      .map((args: any[]) => args[0] as any)
      .filter((ev: any) => ev.stage === 4 && ev.status === 'PASS' && ev.strategyId === 'ScalperV2');

    expect(scalperPass.length).toBeGreaterThan(0);
    for (const ev of scalperPass) {
      const out = ev.outputSummary;
      expect(typeof out.ema9).toBe('number');
      expect(Number.isFinite(out.ema9)).toBe(true);
      expect(typeof out.ema21).toBe('number');
      expect(Number.isFinite(out.ema21)).toBe(true);
      expect(out.ema50).toBeNull();
      expect(out.ema200).toBeNull();
    }
  });

  /**
   * T5: Momentum — ema50 and ema200 populated; ema9/ema21 absent (undefined).
   */
  it('T5: Momentum ema50/ema200 populated; ema9/ema21 absent', async () => {
    const telemetryCtx = { userId: 'test_user', cycleId: 'cycle_t5', sink: undefined as any };
    await orchestrator.executeCycle('BTCUSDT', 'Momentum', undefined, 1000, telemetryCtx);

    const momentumPass = emitMock().mock.calls
      .map((args: any[]) => args[0] as any)
      .filter((ev: any) => ev.stage === 4 && ev.status === 'PASS' && ev.strategyId === 'Momentum' && !ev.outputSummary.indicatorsUnavailableReason);

    expect(momentumPass.length).toBeGreaterThan(0);

    // Momentum 1h/4h are rejected before indicators (insufficient CLOSED candles for EMA200):
    // they must stay unavailable, never fabricated.
    const momentumRejected = emitMock().mock.calls
      .map((args: any[]) => args[0] as any)
      .filter((ev: any) => ev.stage === 4 && ev.strategyId === 'Momentum' && ev.outputSummary.indicatorsUnavailableReason);
    for (const ev of momentumRejected) {
      expect(ev.outputSummary.rsi).toBeNull();
      expect(ev.outputSummary.ema50).toBeNull();
      expect(ev.outputSummary.ema200).toBeNull();
      expect(ev.outputSummary.atr).toBeNull();
    }
    for (const ev of momentumPass) {
      const out = ev.outputSummary;
      expect(typeof out.ema50).toBe('number');
      expect(Number.isFinite(out.ema50)).toBe(true);
      expect(typeof out.ema200).toBe('number');
      expect(Number.isFinite(out.ema200)).toBe(true);
      expect(out.ema9).toBeNull();
      expect(out.ema21).toBeNull();
    }
  });

  /**
   * T6: MeanReversion/VWAP — ema50 populated (slow=50); ema9/ema200 absent.
   */
  it('T6: MeanReversion/VWAP emit ema50 populated; ema9/ema200 absent', async () => {
    for (const stratId of ['MeanReversion', 'VWAP'] as const) {
      emitMock().mockClear();
      const telemetryCtx = { userId: 'test_user', cycleId: `cycle_t6_${stratId}`, sink: undefined as any };
      await orchestrator.executeCycle('BTCUSDT', stratId, undefined, 1000, telemetryCtx);

      const passEvts = emitMock().mock.calls
        .map((args: any[]) => args[0] as any)
        .filter((ev: any) => ev.stage === 4 && ev.status === 'PASS' && ev.strategyId === stratId);

      expect(passEvts.length, `${stratId} should emit Stage 4 PASS`).toBeGreaterThan(0);
      for (const ev of passEvts) {
        const out = ev.outputSummary;
        // emaSlowPeriod=50 → ema50 populated; emaFastPeriod=20 → not a named field
        expect(typeof out.ema50).toBe('number');
        expect(Number.isFinite(out.ema50)).toBe(true);
        expect(out.ema9).toBeNull();
        expect(out.ema200).toBeNull();
      }
    }
  });

  /**
   * T7: telemetry sink failure must not throw or affect returned EvaluationResult.
   */
  it('T7: telemetry extraction error does not throw or affect returned EvaluationResult', async () => {
    // Throw only for Stage 4 emissions (MarketDataEngine's own stage spans are unrelated)
    emitMock().mockImplementation((ev: any) => {
      if (ev?.stage === 4) throw new Error('Simulated telemetry sink failure');
      return null;
    });

    const telemetryCtx = { userId: 'test_user', cycleId: 'cycle_t7', sink: undefined as any };
    const results = await orchestrator.executeCycle('BTCUSDT', 'ScalperV2', undefined, 1000, telemetryCtx);
    // All supported timeframes still return real EvaluationResults with indicators intact
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.strategyId).toBe('ScalperV2');
      expect(r.metadata?.indicatorSnapshot).toBeDefined();
    }
  });

  /**
   * T8: boundary SKIPPED (minRequiredBars-1) — confirm no numeric indicator leaks.
   */
  it('T8: boundary SKIPPED (minRequiredBars-1 candles) emits no indicator values', async () => {
    // ScalperV2 minimumCandles = 35; provide exactly 34
    (mockProvider.fetchCandles as ReturnType<typeof vi.fn>).mockResolvedValue(
      createClosedCandles(34, 50000)
    );

    const telemetryCtx = { userId: 'test_user', cycleId: 'cycle_t8', sink: undefined as any };
    await orchestrator.executeCycle('BTCUSDT', 'ScalperV2', undefined, 1000, telemetryCtx);

    const skippedEvts = emitMock().mock.calls
      .map((args: any[]) => args[0] as any)
      .filter((ev: any) => ev.stage === 4 && ev.status === 'SKIPPED');

    expect(skippedEvts.length).toBeGreaterThan(0);
    const numericIndicatorKeys = ['rsi', 'ema9', 'ema21', 'ema50', 'ema200', 'macdLine', 'macdSignal', 'macdHist', 'atr'];
    for (const ev of skippedEvts) {
      for (const key of numericIndicatorKeys) {
        expect(ev.outputSummary[key], `Boundary SKIPPED must not emit ${key}`).not.toEqual(expect.any(Number));
      }
    }
  });
});
