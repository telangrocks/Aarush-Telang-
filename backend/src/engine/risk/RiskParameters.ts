export interface RiskParameters {
  accountRiskPercent: number; // e.g. 1%
  maxExposureLimit: number; // Maximum position size in base currency/percentage of portfolio
  atrStopLossMultiplier: number; // e.g. 1.5
  riskRewardRatio: number; // e.g. 2.0 for 1:2 R:R
  atrTakeProfitMultiplier?: number; // Optional, typically derived from R:R or ATR directly
}
