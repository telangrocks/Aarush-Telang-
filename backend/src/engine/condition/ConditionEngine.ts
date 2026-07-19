import { IndicatorSnapshot } from '../indicator/IndicatorTypes';
import { ConditionConfig, ConditionResult, TimeframeConditionResult } from './ConditionTypes';
import { evaluateTrend } from './conditions/TrendConditions';
import { evaluateMomentum } from './conditions/MomentumConditions';
import { evaluateVolatility } from './conditions/VolatilityConditions';
import { evaluateVolume } from './conditions/VolumeConditions';

export class ConditionEngine {
  constructor(private config: ConditionConfig) {}

  public evaluate(indicatorSnapshot: IndicatorSnapshot): ConditionResult {
    const result: ConditionResult = {
      timestamp: indicatorSnapshot.timestamp,
      timeframes: {}
    };

    for (const [tf, indicators] of Object.entries(indicatorSnapshot.timeframes)) {
      const timeframeResult: TimeframeConditionResult = {
        trend: evaluateTrend(indicators, this.config),
        momentum: evaluateMomentum(indicators, this.config),
        volatility: evaluateVolatility(indicators, this.config),
        volume: evaluateVolume(indicators, this.config)
      };

      result.timeframes[tf] = timeframeResult;
    }

    return result;
  }
}
