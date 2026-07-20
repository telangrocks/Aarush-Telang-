import { IndicatorConfig } from '../../indicator/IndicatorTypes';
import { ConditionConfig } from '../../condition';
import { ConfidenceWeights } from '../../confidence';
import { RiskParameters } from '../../risk';
import { SignalRules } from '../../signal';

export interface MeanReversionConfig {
  preferredTimeframes: string[];
  indicatorConfig: IndicatorConfig;
  conditionConfig: ConditionConfig;
  confidenceWeights: ConfidenceWeights;
  riskParameters: RiskParameters;
  signalRules: SignalRules;
  // Strategy-specific custom logic settings:
  trendFilter: {
    maxEmaSeparationPercent: number; // Avoid fading when EMA separation is too large
    requireTrendStabilization: boolean; // Require ATR/Momentum to stabilize
  };
  entryRules: {
    requireTwoStepConfirmation: boolean; // Wait for RSI to turn back or MACD to improve
  };
}

export const DEFAULT_MEAN_REVERSION_CONFIG: MeanReversionConfig = {
  preferredTimeframes: ['15m', '1h'],
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
    rsiOverbought: 75, // Stricter bounds for mean reversion
    rsiOversold: 25,
    macdKey: '12,26,9',
    atrPeriod: 14,
    volumePeriod: 20
  },
  confidenceWeights: {
    trend: 10, // Trend alignment is less important for mean reversion
    momentum: 40, // Momentum extremes are heavily weighted
    volatility: 30, // Needs volatility exhaustion
    volume: 20
  },
  riskParameters: {
    accountRiskPercent: 0.5, // Lower risk on counter-trend trades
    maxExposureLimit: 10.0,
    atrStopLossMultiplier: 1.2, // Tighter stop loss, reversions can fail fast
    riskRewardRatio: 2.5 // Target reversion to the mean
  },
  signalRules: {
    minConfidenceScore: 75,
    allowedRiskClassifications: ['LOW', 'MEDIUM']
  },
  trendFilter: {
    maxEmaSeparationPercent: 5.0, // e.g. 5% separation between fast/slow EMA is too strong
    requireTrendStabilization: true
  },
  entryRules: {
    requireTwoStepConfirmation: true
  }
};
