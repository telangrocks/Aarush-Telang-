import { IndicatorConfig } from '../../indicator/IndicatorTypes';
import { ConditionConfig } from '../../condition';
import { ConfidenceWeights } from '../../confidence';
import { RiskParameters } from '../../risk';
import { SignalRules } from '../../signal';

export interface BreakoutConfig {
  preferredTimeframes: string[];
  indicatorConfig: IndicatorConfig;
  conditionConfig: ConditionConfig;
  confidenceWeights: ConfidenceWeights;
  riskParameters: RiskParameters;
  signalRules: SignalRules;
}

export const DEFAULT_BREAKOUT_CONFIG: BreakoutConfig = {
  preferredTimeframes: ['15m', '1h', '4h'],
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
    trend: 30,
    momentum: 30,
    volatility: 20,
    volume: 20
  },
  riskParameters: {
    accountRiskPercent: 1.0,
    maxExposureLimit: 20.0,
    atrStopLossMultiplier: 2.0, // Wider stop loss
    riskRewardRatio: 3.0 // Aim for larger moves
  },
  signalRules: {
    minConfidenceScore: 70,
    allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH'] // Breakouts might be classified as high risk sometimes
  }
};
