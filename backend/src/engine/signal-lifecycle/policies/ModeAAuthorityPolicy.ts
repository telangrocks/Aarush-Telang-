import { NormalizedObservation } from '../types/SignalLifecycleTypes';

export interface PrimarySelectionResult {
  primary: NormalizedObservation;
  mode: 'MODE_A' | 'HIGHEST_CONFIDENCE';
}

const TIMEFRAME_PRIORITY: Record<string, number> = {
  '4h': 4,
  '1h': 3,
  '15m': 2,
  '5m': 1,
};

/**
 * ModeAAuthorityPolicy
 *
 * Implements authoritative primary observation selection:
 * - When committedStrategyId is set (Mode A): any observation from that strategy has absolute authority.
 *   Secondary strategies cannot veto, suppress, or modify it.
 * - When uncommitted (fallback): select highest-confidence observation.
 * - Deterministic tie-breaking: timeframe priority (4h > 1h > 15m > 5m), then alphabetical strategyId.
 */
export class ModeAAuthorityPolicy {
  public static selectPrimaryObservation(
    observations: NormalizedObservation[],
    committedStrategyId: string | null | undefined
  ): PrimarySelectionResult | null {
    if (!observations || observations.length === 0) {
      return null;
    }

    // Check Mode A: Committed strategy
    if (committedStrategyId && typeof committedStrategyId === 'string' && committedStrategyId.trim().length > 0) {
      const normalizedCommitted = committedStrategyId.trim().toLowerCase();
      const committedObs = observations.filter(
        obs => obs.strategyId.trim().toLowerCase() === normalizedCommitted
      );

      if (committedObs.length > 0) {
        return {
          primary: this.pickBestObservation(committedObs),
          mode: 'MODE_A',
        };
      }
    }

    // Fallback: Highest confidence among all observations
    return {
      primary: this.pickBestObservation(observations),
      mode: 'HIGHEST_CONFIDENCE',
    };
  }

  private static pickBestObservation(obsList: NormalizedObservation[]): NormalizedObservation {
    const sorted = [...obsList].sort((a, b) => {
      // 1. Highest confidence
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      // 2. Timeframe priority: 4h > 1h > 15m > 5m
      const aPriority = TIMEFRAME_PRIORITY[a.timeframe] || 0;
      const bPriority = TIMEFRAME_PRIORITY[b.timeframe] || 0;
      if (bPriority !== aPriority) {
        return bPriority - aPriority;
      }
      // 3. Alphabetical strategyId
      return a.strategyId.localeCompare(b.strategyId);
    });

    return sorted[0];
  }
}
