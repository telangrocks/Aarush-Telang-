import { TimeframeIndicators } from '../../indicator/IndicatorTypes';
import { MomentumConditionResult, ConditionConfig } from '../ConditionTypes';

export function evaluateMomentum(indicators: TimeframeIndicators, config: ConditionConfig): MomentumConditionResult {
  const rsiArray = indicators.rsi[config.rsiPeriod];
  const macdArray = indicators.macd[config.macdKey];

  let rsiState: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' = 'NEUTRAL';
  let macdDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';

  if (rsiArray && rsiArray.length > 0) {
    const currentRSI = rsiArray[rsiArray.length - 1];
    if (currentRSI >= config.rsiOverbought) {
      rsiState = 'OVERBOUGHT';
    } else if (currentRSI <= config.rsiOversold) {
      rsiState = 'OVERSOLD';
    }
  }

  if (macdArray && macdArray.length >= 2) {
    const currentMACD = macdArray[macdArray.length - 1];
    const prevMACD = macdArray[macdArray.length - 2];

    if (currentMACD.histogram > 0 && currentMACD.histogram > prevMACD.histogram) {
      macdDirection = 'BULLISH';
    } else if (currentMACD.histogram < 0 && currentMACD.histogram < prevMACD.histogram) {
      macdDirection = 'BEARISH';
    }
  }

  return {
    rsiState,
    macdDirection
  };
}
