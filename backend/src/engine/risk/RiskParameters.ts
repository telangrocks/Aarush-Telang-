export interface RiskParameters {
  accountRiskPercent?: number; // Optional legacy parameter (inert in Model A)
  maxExposureLimit: number; // Maximum order size in base currency/percentage of portfolio
  atrStopLossMultiplier: number; // e.g. 1.5
  atrTakeProfitMultiplier: number; // e.g. 2.0 (Authoritative Model A: TP Distance = ATR * atrTakeProfitMultiplier)
  riskRewardRatio?: number; // @deprecated Legacy migration fallback only; does not participate in Model A calculations
}

