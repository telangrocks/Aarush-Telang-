import { IndicatorConfig } from '../../indicator/IndicatorTypes';
import { ConditionConfig } from '../../condition';
import { ConfidenceWeights } from '../../confidence';
import { RiskParameters } from '../../risk';
import { SignalRules } from '../../signal';

export interface VWAPConfig {
  preferredTimeframes: string[];
  indicatorConfig: IndicatorConfig;
  conditionConfig: ConditionConfig;
  confidenceWeights: ConfidenceWeights;
  riskParameters: RiskParameters;
  signalRules: SignalRules;
  // Strategy-specific custom logic settings:
  vwapRules: {
    maxDeviationThresholdPercent: number; // Max distance from VWAP before rejecting trade
    minVolumeMultiplier: number; // Volume must be X times the average volume to confirm
    minSidewaysDisplacementPercent: number; // Minimum price displacement to avoid sideways chop
  };
}

export const DEFAULT_VWAP_CONFIG: VWAPConfig = {
  preferredTimeframes: ['15m', '1h', '4h'],
  indicatorConfig: {
    rsiPeriods: [14],
    smaPeriods: [50, 200],
    emaPeriods: [20, 50],
    macdParams: [{ fast: 12, slow: 26, signal: 9 }],
    atrPeriods: [14],
    volumeAveragePeriod: 20
  },
  conditionConfig: {
    emaFastPeriod: 20,
    emaSlowPeriod: 50,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    macdKey: '12,26,9',
    atrPeriod: 14,
    volumePeriod: 20
  },
  confidenceWeights: {
    trend: 30,
    momentum: 20,
    volatility: 10,
    volume: 40 // Heavy emphasis on volume confirmation for VWAP breakouts
  },
  riskParameters: {
    accountRiskPercent: 1.0, // Standard risk
    maxExposureLimit: 20.0,
    atrStopLossMultiplier: 1.5,
    riskRewardRatio: 2.0
  },
  signalRules: {
    minConfidenceScore: 70,
    allowedRiskClassifications: ['LOW', 'MEDIUM']
  },
  vwapRules: {
    maxDeviationThresholdPercent: 3.0, // e.g. 3% away from VWAP is considered extended
    minVolumeMultiplier: 1.5, // Current volume must be 1.5x average
    minSidewaysDisplacementPercent: 0.2 // Needs 0.2% displacement to trigger, avoiding flat chop
  }
};
