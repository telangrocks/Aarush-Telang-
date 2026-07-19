import { TimeframeIndicators } from '../../indicator/IndicatorTypes';
import { VolatilityConditionResult, ConditionConfig } from '../ConditionTypes';

export function evaluateVolatility(indicators: TimeframeIndicators, config: ConditionConfig): VolatilityConditionResult {
  const atrArray = indicators.atr[config.atrPeriod];
  
  let atrState: 'EXPANDING' | 'CONTRACTING' | 'NEUTRAL' = 'NEUTRAL';

  if (atrArray && atrArray.length >= 2) {
    const currentATR = atrArray[atrArray.length - 1];
    const prevATR = atrArray[atrArray.length - 2];

    if (currentATR > prevATR) {
      atrState = 'EXPANDING';
    } else if (currentATR < prevATR) {
      atrState = 'CONTRACTING';
    }
  }

  return {
    atrState
  };
}
