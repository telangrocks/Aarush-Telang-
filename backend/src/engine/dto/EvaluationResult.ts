export interface EvaluationResult {
  strategyId: string;
  timestamp: number;
  confidenceScore: number;
  hasSignal: boolean;
  metadata: {
    reasoning: string[];
    [key: string]: any;
  };
}
