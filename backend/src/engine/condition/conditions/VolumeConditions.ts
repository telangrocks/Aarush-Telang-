import { TimeframeIndicators } from '../../indicator/IndicatorTypes';
import { VolumeConditionResult, ConditionConfig } from '../ConditionTypes';

export function evaluateVolume(indicators: TimeframeIndicators, config: ConditionConfig): VolumeConditionResult {
  const volumeArray = indicators.volume;
  
  let volumeTrend: 'INCREASING' | 'DECREASING' | 'NEUTRAL' = 'NEUTRAL';
  let volumeConfirmation = false;

  if (volumeArray && volumeArray.length >= 2) {
    const currentVol = volumeArray[volumeArray.length - 1];
    const prevVol = volumeArray[volumeArray.length - 2];

    if (currentVol.averageVolume > prevVol.averageVolume) {
      volumeTrend = 'INCREASING';
    } else if (currentVol.averageVolume < prevVol.averageVolume) {
      volumeTrend = 'DECREASING';
    }

    // A simple confirmation rule: If volume increased by more than a threshold, e.g., 20%
    if (currentVol.volumeChangePercent > 20) {
      volumeConfirmation = true;
    }
  }

  return {
    volumeTrend,
    volumeConfirmation
  };
}
