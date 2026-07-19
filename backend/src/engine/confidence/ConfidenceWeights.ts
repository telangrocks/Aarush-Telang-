export interface ConfidenceWeights {
  trend: number;
  momentum: number;
  volatility: number;
  volume: number;
}

export const DEFAULT_WEIGHTS: ConfidenceWeights = {
  trend: 40,
  momentum: 30,
  volatility: 15,
  volume: 15
};
