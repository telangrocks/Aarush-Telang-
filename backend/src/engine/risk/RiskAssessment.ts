export type RiskClassification = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

export interface RiskAssessment {
  timestamp: number;
  stopLossDistance: number;
  takeProfitDistance: number;
  riskRewardRatio: number;
  positionSizeRecommendation: number; // Quoted in quote currency (e.g. USDT)
  maximumExposure: number; // Max risk amount allowed per trade
  riskClassification: RiskClassification;
  explanation: string[];
}
