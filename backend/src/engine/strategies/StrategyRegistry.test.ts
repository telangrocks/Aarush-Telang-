import { describe, it, expect, beforeEach } from 'vitest';
import { StrategyRegistry } from './StrategyRegistry';

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
      const strategy = registry.createStrategy(alias, { leverage: '25', risk_level: 'High' });
      expect(strategy).toBeDefined();
      expect(strategy?.manifest.id).toBe(expectedId);
    }
  });
});
