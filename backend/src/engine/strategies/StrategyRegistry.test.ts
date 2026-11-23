import { describe, it, expect } from 'vitest';
import { StrategyRegistry } from './StrategyRegistry';
import { StrategyContext } from '../context/StrategyContext';
import { MarketSnapshot } from '../market-data/MarketSnapshot';

describe('StrategyRegistry', () => {
  it('should have deterministic initialization and prevent duplicates', () => {
    const registry = StrategyRegistry.getInstance();
    
    // Check initial strategies
    const available = registry.getAvailableStrategies();
    expect(available).toContain('ScalperV2');
    expect(available).toContain('Momentum');

    // Duplicate registration should throw
    expect(() => {
      registry.registerStrategy('ScalperV2', {} as any);
    }).toThrow(/already registered/);
  });

  it('should return valid manifests for registered strategies', () => {
    const registry = StrategyRegistry.getInstance();
    const manifests = registry.getAllManifests();
    
    expect(manifests.length).toBeGreaterThanOrEqual(2);
    
    const scalperManifest = registry.getManifest('ScalperV2');
    expect(scalperManifest).toBeDefined();
    expect(scalperManifest?.id).toBe('ScalperV2');
    expect(scalperManifest?.version).toBeDefined();
    expect(scalperManifest?.supportedTimeframes).toBeInstanceOf(Array);
    
    const momentumManifest = registry.getManifest('Momentum');
    expect(momentumManifest).toBeDefined();
    expect(momentumManifest?.id).toBe('Momentum');
    expect(momentumManifest?.version).toBeDefined();
    expect(momentumManifest?.supportedTimeframes).toBeInstanceOf(Array);
  });
  
  it('every registered strategy must implement IStrategy and have a manifest', () => {
    const registry = StrategyRegistry.getInstance();
    const strategies = registry.getAllStrategies();
    
    for (const [id, strategy] of strategies.entries()) {
      expect(strategy).toBeDefined();
      expect(strategy.evaluate).toBeInstanceOf(Function);
      expect(strategy.manifest).toBeDefined();
      expect(strategy.manifest.id).toBe(id);
    }
  });

  it('should normalize strategy aliases and instantiate all 5 strategies with config overrides', () => {
    const registry = StrategyRegistry.getInstance();

    const aliases = [
      { alias: 'scalper-v2', expectedId: 'ScalperV2' },
      { alias: 'scalping', expectedId: 'ScalperV2' },
      { alias: 'breakout', expectedId: 'Breakout' },
      { alias: 'mean_reversion', expectedId: 'MeanReversion' },
      { alias: 'mean-reversion', expectedId: 'MeanReversion' },
      { alias: 'momentum', expectedId: 'Momentum' },
      { alias: 'vwap', expectedId: 'VWAP' },
    ];

    for (const { alias, expectedId } of aliases) {
      const strategy = registry.createStrategy(alias, { risk_level: 'High' });
      expect(strategy).toBeDefined();
      expect(strategy?.manifest.id).toBe(expectedId);
    }
  });
  it('should safely deep merge explicitly permitted objects like riskParameters', () => {
    const registry = StrategyRegistry.getInstance();
    const strategy = registry.createStrategy('ScalperV2', {
      riskParameters: {
        atrStopLossMultiplier: 2.5
      }
    });

    expect(strategy).toBeDefined();
    expect((strategy as any).config.riskParameters.atrStopLossMultiplier).toBe(2.5);
    // ensure maxExposureLimit is preserved
    expect((strategy as any).config.riskParameters.maxExposureLimit).toBeDefined();
    expect((strategy as any).config.riskParameters.maxExposureLimit).toBe(20.0);
  });

  it('should safely merge atrTakeProfitMultiplier under Model A', () => {
    const registry = StrategyRegistry.getInstance();
    const strategy = registry.createStrategy('ScalperV2', {
      riskParameters: {
        atrTakeProfitMultiplier: 3.5,
        atrStopLossMultiplier: 1.8
      }
    });

    expect((strategy as any).config.riskParameters.atrTakeProfitMultiplier).toBe(3.5);
    expect((strategy as any).config.riskParameters.atrStopLossMultiplier).toBe(1.8);
  });

  it('should reject invalid riskParameters bounds', () => {
    const registry = StrategyRegistry.getInstance();

    expect(() => {
      registry.createStrategy('ScalperV2', { riskParameters: { atrTakeProfitMultiplier: 0.5 } });
    }).toThrow(/Invalid atrTakeProfitMultiplier/);

    expect(() => {
      registry.createStrategy('ScalperV2', { riskParameters: { atrTakeProfitMultiplier: 6.0 } });
    }).toThrow(/Invalid atrTakeProfitMultiplier/);

    expect(() => {
      registry.createStrategy('ScalperV2', { riskParameters: { riskRewardRatio: 0.5 } });
    }).toThrow(/Invalid riskRewardRatio/);

    expect(() => {
      registry.createStrategy('ScalperV2', { riskParameters: { riskRewardRatio: 6.0 } });
    }).toThrow(/Invalid riskRewardRatio/);

    expect(() => {
      registry.createStrategy('ScalperV2', { riskParameters: { atrStopLossMultiplier: 0.1 } });
    }).toThrow(/Invalid atrStopLossMultiplier/);
  });

  it('should evaluate all 5 registered plugins independently against the same frozen MarketSnapshot', () => {
    const registry = StrategyRegistry.getInstance();
    const scalper = registry.getStrategy('ScalperV2');
    const momentum = registry.getStrategy('Momentum');
    const breakout = registry.getStrategy('Breakout');
    const meanReversion = registry.getStrategy('MeanReversion');
    const vwap = registry.getStrategy('VWAP');

    expect(scalper).toBeDefined();
    expect(momentum).toBeDefined();
    expect(breakout).toBeDefined();
    expect(meanReversion).toBeDefined();
    expect(vwap).toBeDefined();

    const snapshot: MarketSnapshot = {
      symbol: 'SOL/USDT',
      timestamp: Date.now(),
      currentPrice: 150,
      volume24h: 100000,
      quoteVolume24h: 15000000,
      metadata: { priceChange24h: 5, priceChangePercent24h: 3.3, highPrice24h: 155, lowPrice24h: 140 },
      candles: {
        '5m': [
          { timestamp: 1, open: 140, high: 145, low: 135, close: 140, volume: 1000 },
          { timestamp: 2, open: 140, high: 145, low: 135, close: 145, volume: 1100 },
          { timestamp: 3, open: 145, high: 155, low: 145, close: 150, volume: 2000 }
        ],
        '15m': [
          { timestamp: 1, open: 140, high: 145, low: 135, close: 140, volume: 1000 },
          { timestamp: 2, open: 140, high: 145, low: 135, close: 145, volume: 1100 },
          { timestamp: 3, open: 145, high: 155, low: 145, close: 150, volume: 2000 }
        ],
        '1h': [
          { timestamp: 1, open: 149, high: 151, low: 148, close: 149, volume: 100 },
          { timestamp: 2, open: 149, high: 151, low: 148, close: 149, volume: 100 },
          { timestamp: 3, open: 149, high: 151, low: 148, close: 150, volume: 100 }
        ]
      } as any
    };

    const context = new StrategyContext(snapshot).freeze();

    const scalperResult = scalper!.evaluate(context, '5m');
    expect(scalperResult.strategyId).toBe('ScalperV2');
    expect(scalperResult.hasSignal).toBeDefined();

    const momentumResult = momentum!.evaluate(context, '5m');
    expect(momentumResult.strategyId).toBe('Momentum');
    expect(momentumResult.hasSignal).toBeDefined();

    const breakoutResult = breakout!.evaluate(context, '5m');
    expect(breakoutResult.strategyId).toBe('Breakout');
    expect(breakoutResult.hasSignal).toBeDefined();

    const meanReversionResult = meanReversion!.evaluate(context, '5m');
    expect(meanReversionResult.strategyId).toBe('MeanReversion');
    expect(meanReversionResult.hasSignal).toBeDefined();

    const vwapResult = vwap!.evaluate(context, '15m');
    expect(vwapResult.strategyId).toBe('VWAP');
    expect(vwapResult.hasSignal).toBeDefined();

    expect(scalperResult.metadata.signal).toBeDefined();
    expect(momentumResult.metadata.signal).toBeDefined();
    expect(breakoutResult.metadata.signal).toBeDefined();

    expect(scalperResult).not.toEqual(momentumResult);
    expect(momentumResult).not.toEqual(breakoutResult);
    expect(breakoutResult).not.toEqual(meanReversionResult);
    expect(meanReversionResult).not.toEqual(vwapResult);
  });
});
