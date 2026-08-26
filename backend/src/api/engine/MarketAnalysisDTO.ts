export interface IndicatorSummary {
  name: string;
  value: string;
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface ConditionSummary {
  id: string;
  name: string;
  currentValue: string;
  targetValue: string;
  status: 'PASSED' | 'FAILED' | 'WAITING';
}

export interface FactorContributionDTO {
  factor: string;
  weight: number;
  score: number;
  level: string;
}

export interface StrategyParameterDTO {
  key: string;
  label: string;
  value: string;
}

export interface StrategyMetadataDTO {
  strategyId: string;
  displayName: string;
  primaryTimeframe: string;
  timeframesAnalyzed: string[];
  category: string;
  riskProfile: string;
  parameters: StrategyParameterDTO[];
  factorContributions: FactorContributionDTO[];
}

export interface MarketAnalysisDTO {
  symbol: string;
  timeframeStatus: string;
  indicatorSummary: IndicatorSummary[];
  conditionSummary: ConditionSummary[];
  confidenceScore: number;
  confidenceExplanation: string[];
}

