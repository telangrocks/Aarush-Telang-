import {
  NormalizedObservation,
  LifecycleTimeframe,
  MarketRegime,
  VALID_LIFECYCLE_TIMEFRAMES,
} from '../types/SignalLifecycleTypes';
import { generateObservationId } from '../identity/ObservationIdentity';

/**
 * SignalDataMapper
 *
 * Implements strict fail-closed ingestion mapping of raw StrategyEvaluationResult / Signal data
 * into NormalizedObservation records.
 *
 * Invariant: Invalid primary values MUST NEVER fall through to secondary values.
 * If a field is explicitly present but malformed, fail closed and drop the observation immediately.
 */
export class SignalDataMapper {
  /**
   * Maps an evaluation result to a NormalizedObservation.
   * Returns null if any required field is invalid or missing.
   */
  public static mapEvaluationToObservation(
    evaluationResult: any,
    fallbackSymbol?: string
  ): NormalizedObservation | null {
    if (!evaluationResult) {
      return null;
    }

    const metadata = evaluationResult.metadata;
    const signal = metadata?.signal;

    // Must have a signal payload
    if (!signal) {
      return null;
    }

    // 1. Direction: strictly 'BUY' or 'SELL'
    const rawType = signal.type ?? signal.direction;
    if (typeof rawType !== 'string') {
      return null;
    }
    const direction = rawType.trim().toUpperCase();
    if (direction !== 'BUY' && direction !== 'SELL') {
      return null;
    }

    // 2. Symbol resolution
    const rawSymbol =
      signal.symbol ??
      evaluationResult.symbol ??
      metadata?.symbol ??
      metadata?.forensicTrace?.symbol ??
      fallbackSymbol;
    if (typeof rawSymbol !== 'string' || rawSymbol.trim().length === 0) {
      return null;
    }
    const symbol = rawSymbol.trim().toUpperCase();

    // 3. Strategy ID resolution
    const rawStrategyId = evaluationResult.strategyId ?? signal.strategyId;
    if (typeof rawStrategyId !== 'string' || rawStrategyId.trim().length === 0) {
      return null;
    }
    const strategyId = rawStrategyId.trim();

    // 4. Confidence resolution (must be a positive finite number)
    const rawConfidence =
      evaluationResult.confidenceScore ?? signal.confidenceScore ?? signal.confidence;
    if (typeof rawConfidence !== 'number' || !Number.isFinite(rawConfidence) || rawConfidence <= 0) {
      return null;
    }
    const confidence = rawConfidence;

    // 5. Timeframe resolution (Fail-Closed)
    // Step 1: inspect signal.timeframe
    let timeframe: LifecycleTimeframe | null = null;
    const primaryTf = signal.timeframe;

    if (primaryTf !== undefined && primaryTf !== null && primaryTf !== '') {
      if (typeof primaryTf === 'string' && (VALID_LIFECYCLE_TIMEFRAMES as readonly string[]).includes(primaryTf.trim())) {
        timeframe = primaryTf.trim() as LifecycleTimeframe;
      } else {
        // Invalid primary timeframe: FAIL CLOSED. Do NOT fall through.
        console.warn(`[SignalDataMapper] Fail-closed: invalid primary timeframe '${primaryTf}' on ${symbol} ${strategyId}`);
        return null;
      }
    } else {
      // Step 2: Only if signal.timeframe is genuinely absent, inspect metadata.targetTimeframe
      const secondaryTf = metadata?.targetTimeframe;
      if (secondaryTf !== undefined && secondaryTf !== null && secondaryTf !== '') {
        if (typeof secondaryTf === 'string' && (VALID_LIFECYCLE_TIMEFRAMES as readonly string[]).includes(secondaryTf.trim())) {
          timeframe = secondaryTf.trim() as LifecycleTimeframe;
        } else {
          // Invalid secondary timeframe: FAIL CLOSED
          console.warn(`[SignalDataMapper] Fail-closed: invalid secondary timeframe '${secondaryTf}' on ${symbol} ${strategyId}`);
          return null;
        }
      } else {
        // Neither present: FAIL CLOSED (Never default silently to '5m')
        return null;
      }
    }

    // 6. Closed Candle Timestamp resolution (Fail-Closed)
    let closedCandleTimestamp: number | null = null;
    const primaryTs = signal.candleTimestamp;

    if (primaryTs !== undefined && primaryTs !== null) {
      if (typeof primaryTs === 'number' && Number.isFinite(primaryTs) && primaryTs > 0) {
        closedCandleTimestamp = Math.floor(primaryTs);
      } else {
        // Invalid primary candleTimestamp: FAIL CLOSED. Do NOT fall through.
        console.warn(`[SignalDataMapper] Fail-closed: invalid primary candleTimestamp '${primaryTs}' on ${symbol} ${strategyId}`);
        return null;
      }
    } else {
      // Step 2: Only if candleTimestamp is genuinely absent, inspect signal.timestamp
      const secondaryTs = signal.timestamp;
      if (secondaryTs !== undefined && secondaryTs !== null) {
        if (typeof secondaryTs === 'number' && Number.isFinite(secondaryTs) && secondaryTs > 0) {
          closedCandleTimestamp = Math.floor(secondaryTs);
        } else {
          // Invalid secondary timestamp: FAIL CLOSED. Do NOT fall through.
          console.warn(`[SignalDataMapper] Fail-closed: invalid secondary timestamp '${secondaryTs}' on ${symbol} ${strategyId}`);
          return null;
        }
      } else {
        // Step 3: Only if both are genuinely absent, inspect trace.latestCandleTimestamp
        const tertiaryTs =
          metadata?.trace?.latestCandleTimestamp ??
          metadata?.forensicTrace?.latestCandleTimestamp;
        if (tertiaryTs !== undefined && tertiaryTs !== null) {
          if (typeof tertiaryTs === 'number' && Number.isFinite(tertiaryTs) && tertiaryTs > 0) {
            closedCandleTimestamp = Math.floor(tertiaryTs);
          } else {
            console.warn(`[SignalDataMapper] Fail-closed: invalid tertiary candleTimestamp '${tertiaryTs}' on ${symbol} ${strategyId}`);
            return null;
          }
        } else {
          // Missing all candle timestamps: FAIL CLOSED (Never substitute wall clock Date.now())
          return null;
        }
      }
    }

    // 7. Entry Price resolution (Fail-Closed)
    let entryPrice: number | null = null;
    const primaryPrice = signal.signalPrice;

    if (primaryPrice !== undefined && primaryPrice !== null) {
      if (typeof primaryPrice === 'number' && Number.isFinite(primaryPrice) && primaryPrice > 0) {
        entryPrice = primaryPrice;
      } else {
        // Invalid primary price: FAIL CLOSED. Do NOT fall through.
        console.warn(`[SignalDataMapper] Fail-closed: invalid primary signalPrice '${primaryPrice}' on ${symbol} ${strategyId}`);
        return null;
      }
    } else {
      // Step 2: Only if signalPrice is genuinely absent, inspect signal.entryPrice
      const secondaryPrice = signal.entryPrice;
      if (secondaryPrice !== undefined && secondaryPrice !== null) {
        if (typeof secondaryPrice === 'number' && Number.isFinite(secondaryPrice) && secondaryPrice > 0) {
          entryPrice = secondaryPrice;
        } else {
          console.warn(`[SignalDataMapper] Fail-closed: invalid secondary entryPrice '${secondaryPrice}' on ${symbol} ${strategyId}`);
          return null;
        }
      } else {
        // Missing both price fields: FAIL CLOSED
        return null;
      }
    }

    // 8. Indicators resolution: optional telemetry
    let indicators: Record<string, any> = {};
    const rawIndicators = signal.indicators ?? metadata?.indicators;
    if (rawIndicators && typeof rawIndicators === 'object' && !Array.isArray(rawIndicators)) {
      indicators = { ...rawIndicators };
    }

    // 9. Regime resolution: optional telemetry
    let regime: MarketRegime = 'UNKNOWN';
    const rawRegime = signal.regime ?? metadata?.regime;
    if (typeof rawRegime === 'string') {
      const upper = rawRegime.trim().toUpperCase();
      if (upper === 'TRENDING' || upper === 'RANGING' || upper === 'VOLATILE') {
        regime = upper as MarketRegime;
      }
    }

    const obsId = generateObservationId(symbol, timeframe, strategyId, closedCandleTimestamp);

    return {
      obsId,
      symbol,
      direction: direction as 'BUY' | 'SELL',
      strategyId,
      timeframe,
      closedCandleTimestamp,
      entryPrice,
      confidence,
      indicators,
      regime,
      receivedAt: Date.now(),
    };
  }
}
