import { StrategyRegistry } from '../strategies/StrategyRegistry';
import { MarketRegime, MarketRegimeEngine } from '../regime/MarketRegimeEngine';
import { StrategyCompatibilityVector } from './ScannerTypes';

/**
 * Evaluates strategy compatibility against market conditions using StrategyRegistry manifests.
 * 
 * INVARIANT: StrategyCompatibility != StrategySignal.
 * This class determines structural suitability, NEVER producing trade signals.
 * The underlying strategy implementations remain the sole authority on entry triggers.
 */
export class StrategyCompatibilityEvaluator {
  private readonly registry: StrategyRegistry;

  constructor(registry?: StrategyRegistry) {
    this.registry = registry ?? StrategyRegistry.getInstance();
  }

  public evaluate(
    regime: MarketRegime,
    direction: 'LONG' | 'SHORT'
  ): StrategyCompatibilityVector[] {
    const manifests = this.registry.getAllManifests();
    const results: StrategyCompatibilityVector[] = [];

    for (const manifest of manifests) {
      const allowedCheck = MarketRegimeEngine.isStrategyAllowed(manifest.id, regime);
      
      const supportsLong = manifest.supportsLong ?? true;
      const supportsShort = manifest.supportsShort ?? false;

      let directionalSupport: 'LONG_ONLY' | 'SHORT_ONLY' | 'LONG_AND_SHORT' = 'LONG_ONLY';
      if (supportsLong && supportsShort) {
        directionalSupport = 'LONG_AND_SHORT';
      } else if (!supportsLong && supportsShort) {
        directionalSupport = 'SHORT_ONLY';
      }

      // Directional gate
      let isDirectionallyCompatible = true;
      let disqualificationReason = allowedCheck.reason;

      if (direction === 'SHORT' && !supportsShort) {
        isDirectionallyCompatible = false;
        disqualificationReason = `Strategy '${manifest.displayName || manifest.id}' only supports LONG entries.`;
      } else if (direction === 'LONG' && !supportsLong) {
        isDirectionallyCompatible = false;
        disqualificationReason = `Strategy '${manifest.displayName || manifest.id}' only supports SHORT entries.`;
      }

      // Calculate compatibility score (0-100 analytical hypothesis)
      let compatibilityScore = 0;
      if (allowedCheck.allowed && isDirectionallyCompatible) {
        // Base score from market regime conviction
        compatibilityScore = Math.min(100, Math.max(50, regime.score));
        
        // Strategy-specific regime affinities
        const normalized = this.registry.normalizeStrategyId(manifest.id);
        if (normalized === 'ScalperV2' && regime.regime === 'TRENDING') {
          compatibilityScore = Math.min(100, compatibilityScore + 15);
        } else if (normalized === 'Momentum' && regime.regime === 'TRENDING') {
          compatibilityScore = Math.min(100, compatibilityScore + 20);
        } else if (normalized === 'Breakout' && regime.regime === 'VOLATILE') {
          compatibilityScore = Math.min(100, compatibilityScore + 20);
        } else if (normalized === 'MeanReversion' && regime.regime === 'RANGING') {
          compatibilityScore = Math.min(100, compatibilityScore + 25);
        }
      }

      results.push({
        strategyId: manifest.id,
        displayName: manifest.displayName || manifest.id,
        isAllowedInRegime: allowedCheck.allowed && isDirectionallyCompatible,
        directionalSupport,
        compatibilityScore,
        disqualificationReason: !allowedCheck.allowed || !isDirectionallyCompatible ? disqualificationReason : undefined,
      });
    }

    return results;
  }
}
