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

export interface MarketAnalysisDTO {
  symbol: string;
  timeframeStatus: string;
  indicatorSummary: IndicatorSummary[];
  conditionSummary: ConditionSummary[];
  confidenceScore: number;
  confidenceExplanation: string[];
}
