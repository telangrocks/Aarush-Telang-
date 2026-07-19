import { NormalizedCandle } from '../../market-data/MarketSnapshot';
import { VolumeResult } from '../IndicatorTypes';

export function calculateVolume(candles: NormalizedCandle[], averagePeriod: number): VolumeResult[] {
  const result: VolumeResult[] = new Array(candles.length).fill(null).map(() => ({
    averageVolume: NaN,
    volumeChangePercent: NaN
  }));

  if (candles.length === 0) return result;

  // Simple moving average of volume
  for (let i = 0; i < candles.length; i++) {
    const currentVol = candles[i].volume;
    
    // Average volume
    if (i >= averagePeriod - 1 && averagePeriod > 0) {
      let sum = 0;
      for (let j = 0; j < averagePeriod; j++) {
        sum += candles[i - j].volume;
      }
      result[i].averageVolume = sum / averagePeriod;
    }

    // Volume change compared to previous candle
    if (i > 0) {
      const prevVol = candles[i - 1].volume;
      if (prevVol === 0) {
        result[i].volumeChangePercent = currentVol > 0 ? 100 : 0;
      } else {
        result[i].volumeChangePercent = ((currentVol - prevVol) / prevVol) * 100;
      }
    }
  }

  return result;
}
