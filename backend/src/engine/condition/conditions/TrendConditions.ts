import { TimeframeIndicators } from '../../indicator/IndicatorTypes';
import { TrendConditionResult, ConditionConfig } from '../ConditionTypes';

export function evaluateTrend(indicators: TimeframeIndicators, config: ConditionConfig): TrendConditionResult {
  const closeArray = indicators.close;
  const currentPrice = closeArray[closeArray.length - 1];

  const fastEmaArray = indicators.ema[config.emaFastPeriod];
  const slowEmaArray = indicators.ema[config.emaSlowPeriod];

  let priceAboveEMA = false;
  let emaCrossoverState: 'BULLISH' | 'BEARISH' | 'NONE' = 'NONE';
  let trendDirection: 'UP' | 'DOWN' | 'SIDEWAYS' = 'SIDEWAYS';

  if (fastEmaArray && fastEmaArray.length > 0) {
    const currentFastEMA = fastEmaArray[fastEmaArray.length - 1];
    priceAboveEMA = currentPrice > currentFastEMA;
  }

  if (fastEmaArray && slowEmaArray && fastEmaArray.length >= 2 && slowEmaArray.length >= 2) {
    const currentFast = fastEmaArray[fastEmaArray.length - 1];
    const prevFast = fastEmaArray[fastEmaArray.length - 2];
    const currentSlow = slowEmaArray[slowEmaArray.length - 1];
    const prevSlow = slowEmaArray[slowEmaArray.length - 2];

    if (currentFast > currentSlow && prevFast <= prevSlow) {
      emaCrossoverState = 'BULLISH';
    } else if (currentFast < currentSlow && prevFast >= prevSlow) {
      emaCrossoverState = 'BEARISH';
    }

    if (currentFast > currentSlow) {
      trendDirection = 'UP';
    } else if (currentFast < currentSlow) {
      trendDirection = 'DOWN';
    }
  }

  return {
    priceAboveEMA,
    emaCrossoverState,
    trendDirection
  };
}
