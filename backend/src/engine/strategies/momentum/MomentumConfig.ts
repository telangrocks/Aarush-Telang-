import { IndicatorConfig } from '../../indicator/IndicatorTypes';
import { ConditionConfig } from '../../condition';
import { ConfidenceWeights } from '../../confidence';
import { RiskParameters } from '../../risk';
import { SignalRules } from '../../signal';

export interface MomentumConfig {
  preferredTimeframes: string[];
  indicatorConfig: IndicatorConfig;
  conditionConfig: ConditionConfig;
  confidenceWeights: ConfidenceWeights;
  riskParameters: RiskParameters;
  signalRules: SignalRules;
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  preferredTimeframes: ['5m', '15m', '1h', '4h'],
  indicatorConfig: {
    rsiPeriods: [14],
    smaPeriods: [50, 200],
    emaPeriods: [50, 200],
    macdParams: [{ fast: 12, slow: 26, signal: 9 }],
    atrPeriods: [14],
    volumeAveragePeriod: 20
  },
  conditionConfig: {
    emaFastPeriod: 50,
    emaSlowPeriod: 200,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    macdKey: '12,26,9',
    atrPeriod: 14,
    volumePeriod: 20
  },
  confidenceWeights: {
    trend: 30,
    momentum: 50,
    volatility: 10,
    volume: 10
  },
  riskParameters: {
    maxExposureLimit: 30.0,
    atrStopLossMultiplier: 2.0,
    atrTakeProfitMultiplier: 2.5,
    riskRewardRatio: 2.5 // @deprecated legacy fallback
  },
  signalRules: {
    minConfidenceScore: 70,
    allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH']
  }
};
