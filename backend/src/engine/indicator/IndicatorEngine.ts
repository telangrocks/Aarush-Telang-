import { MarketSnapshot } from '../market-data/MarketSnapshot';
import { IndicatorSnapshot, IndicatorConfig, TimeframeIndicators } from './IndicatorTypes';
import { calculateRSI } from './indicators/RSI';
import { calculateSMA } from './indicators/SMA';
import { calculateEMA } from './indicators/EMA';
import { calculateMACD } from './indicators/MACD';
import { calculateATR } from './indicators/ATR';
import { calculateVolume } from './indicators/VolumeIndicators';

export class IndicatorEngine {
  constructor(private config: IndicatorConfig) {}

  public evaluate(snapshot: MarketSnapshot): IndicatorSnapshot {
    const result: IndicatorSnapshot = {
      timestamp: snapshot.timestamp,
      timeframes: {}
    };

    for (const [tf, candles] of Object.entries(snapshot.candles)) {
      const indicators: TimeframeIndicators = {
        rsi: {},
        sma: {},
        ema: {},
        macd: {},
        atr: {},
        volume: calculateVolume(candles, this.config.volumeAveragePeriod)
      };

      for (const period of this.config.rsiPeriods) {
        indicators.rsi[period] = calculateRSI(candles, period);
      }

      for (const period of this.config.smaPeriods) {
        indicators.sma[period] = calculateSMA(candles, period);
      }

      for (const period of this.config.emaPeriods) {
        indicators.ema[period] = calculateEMA(candles, period);
      }

      for (const params of this.config.macdParams) {
        const key = `${params.fast},${params.slow},${params.signal}`;
        indicators.macd[key] = calculateMACD(candles, params.fast, params.slow, params.signal);
      }

      for (const period of this.config.atrPeriods) {
        indicators.atr[period] = calculateATR(candles, period);
      }

      result.timeframes[tf] = indicators;
    }

    return result;
  }
}
