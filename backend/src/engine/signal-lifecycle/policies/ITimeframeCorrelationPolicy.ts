import { NormalizedObservation } from '../types/SignalLifecycleTypes';

/**
 * Interface for cross-timeframe correlation scoring policies.
 */
export interface ITimeframeCorrelationPolicy {
  /**
   * Calculates a correlation score between the primary observation and supporting/conflicting observations.
   *
   * @param primary The primary observation for the opportunity
   * @param others Other observations on the same symbol across timeframes
   * @returns Correlation score normalized between 0.0 and 1.0
   */
  calculateCorrelation(primary: NormalizedObservation, others: NormalizedObservation[]): number;
}
