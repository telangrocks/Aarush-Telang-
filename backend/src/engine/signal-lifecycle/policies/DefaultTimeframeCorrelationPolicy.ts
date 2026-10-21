import { NormalizedObservation } from '../types/SignalLifecycleTypes';
import { ITimeframeCorrelationPolicy } from './ITimeframeCorrelationPolicy';

/**
 * DefaultTimeframeCorrelationPolicy
 *
 * Implements cross-timeframe alignment scoring:
 * - Base score: normalized primary observation confidence (0.0 to 1.0)
 * - Alignment bonus: +0.05 for each agreeing observation on a different timeframe
 * - Disagreement penalty: -0.10 for each disagreeing observation on a different timeframe
 * - Clamped strictly between 0.0 and 1.0
 */
export class DefaultTimeframeCorrelationPolicy implements ITimeframeCorrelationPolicy {
  public calculateCorrelation(
    primary: NormalizedObservation,
    others: NormalizedObservation[]
  ): number {
    if (!primary) return 0;

    // Normalize confidence (handles 0..100 scale or 0..1 scale)
    let baseScore = primary.confidence > 1 ? primary.confidence / 100 : primary.confidence;
    baseScore = Math.max(0, Math.min(1, baseScore));

    if (!others || others.length === 0) {
      return Number(baseScore.toFixed(4));
    }

    let score = baseScore;

    for (const obs of others) {
      // Cross-timeframe only
      if (obs.timeframe === primary.timeframe) {
        continue;
      }

      if (obs.direction === primary.direction) {
        score += 0.05;
      } else {
        score -= 0.10;
      }
    }

    return Number(Math.max(0, Math.min(1, score)).toFixed(4));
  }
}
