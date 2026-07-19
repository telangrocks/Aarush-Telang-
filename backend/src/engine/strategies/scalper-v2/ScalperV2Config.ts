import { IndicatorConfig } from '../../indicator/IndicatorTypes';
import { ConditionConfig } from '../../condition';
import { ConfidenceWeights } from '../../confidence';
import { RiskParameters } from '../../risk';
import { SignalRules } from '../../signal';

export interface ScalperV2Config {
  preferredTimeframes: string[];
  indicatorConfig: IndicatorConfig;
  conditionConfig: ConditionConfig;
  confidenceWeights: ConfidenceWeights;
  riskParameters: RiskParameters;
  signalRules: SignalRules;
}

export const DEFAULT_SCALPER_CONFIG: ScalperV2Config = {
  preferredTimeframes: ['5m', '15m', '30m'],
  indicatorConfig: {
    rsiPeriods: [14],
    smaPeriods: [50, 200],
    emaPeriods: [9, 21],
    macdParams: [{ fast: 12, slow: 26, signal: 9 }],
    atrPeriods: [14],
    volumeAveragePeriod: 20
  },
  conditionConfig: {
    emaFastPeriod: 9,
    emaSlowPeriod: 21,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    macdKey: '12,26,9',
    atrPeriod: 14,
    volumePeriod: 20
  },
  confidenceWeights: {
    trend: 40,
    momentum: 30,
    volatility: 15,
    volume: 15
  },
  riskParameters: {
    accountRiskPercent: 1.0,
    maxExposureLimit: 20.0,
    atrStopLossMultiplier: 1.5,
    riskRewardRatio: 2.0
  },
  signalRules: {
    minConfidenceScore: 75,
    allowedRiskClassifications: ['LOW', 'MEDIUM']
  }
};
