export type RiskClassification = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

export interface RiskAssessment {
  timestamp: number;
  stopLossDistance: number;
  takeProfitDistance: number;
  riskRewardRatio: number;
  positionSizeRecommendation?: number; // Optional (Model B legacy)
  maximumExposure: number; // Max risk amount allowed per trade
  riskClassification: RiskClassification;
  explanation: string[];
}
