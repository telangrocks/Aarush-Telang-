import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrategyOrchestrator } from './StrategyOrchestrator';
import { MarketDataEngine } from '../market-data/MarketDataEngine';
import { StrategyRegistry } from '../strategies/StrategyRegistry';
import { ICandleProvider } from '../../infrastructure/exchange/types';
import { BackendDiagnosticSink } from '../../telemetry/BackendDiagnosticSink';
import { Timeframe } from '../market-data/Timeframe';

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
});
