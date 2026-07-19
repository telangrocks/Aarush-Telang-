import { RiskParameters } from './RiskParameters';
import { RiskAssessment, RiskClassification } from './RiskAssessment';
import { StopLossCalculator } from './StopLossCalculator';
import { TakeProfitCalculator } from './TakeProfitCalculator';
import { PositionSizing } from './PositionSizing';

export interface RiskContext {
  timestamp: number;
  currentPrice: number;
  currentAtr: number;
  accountBalance: number;
}

export class RiskEngine {
  constructor(private config: RiskParameters) {}

  public evaluate(context: RiskContext): RiskAssessment {
    const explanation: string[] = [];

    // Calculate Stop Loss
    const stopLossDistance = StopLossCalculator.calculateDistance(context.currentAtr, this.config);
    explanation.push(`Stop Loss distance calculated at ${stopLossDistance.toFixed(2)} (ATR multiplier: ${this.config.atrStopLossMultiplier}).`);

    // Calculate Take Profit
    const takeProfitDistance = TakeProfitCalculator.calculateDistance(stopLossDistance, this.config);
    explanation.push(`Take Profit distance calculated at ${takeProfitDistance.toFixed(2)} (R:R ratio: ${this.config.riskRewardRatio}).`);

    // Calculate Position Size
    const positionSize = PositionSizing.calculateSize(
      context.accountBalance,
      stopLossDistance,
      context.currentPrice,
      this.config
    );
    explanation.push(`Position size recommended at ${positionSize.toFixed(2)} (Risk: ${this.config.accountRiskPercent}% of balance).`);

    // Assess risk classification based on exposure and volatility
    const riskAmount = context.accountBalance * (this.config.accountRiskPercent / 100);
    const maxAllowedExposure = context.accountBalance * (this.config.maxExposureLimit / 100);
    
    let riskClassification: RiskClassification = 'LOW';
    if (positionSize >= maxAllowedExposure * 0.9) {
      riskClassification = 'EXTREME';
      explanation.push('Risk classification is EXTREME due to hitting maximum exposure limits.');
    } else if (this.config.accountRiskPercent >= 5) {
      riskClassification = 'HIGH';
      explanation.push('Risk classification is HIGH due to aggressive account risk percentage.');
    } else if (this.config.accountRiskPercent >= 2) {
      riskClassification = 'MEDIUM';
      explanation.push('Risk classification is MEDIUM.');
    } else {
      explanation.push('Risk classification is LOW.');
    }

    return {
      timestamp: context.timestamp,
      stopLossDistance,
      takeProfitDistance,
      riskRewardRatio: this.config.riskRewardRatio,
      positionSizeRecommendation: positionSize,
      maximumExposure: maxAllowedExposure,
      riskClassification,
      explanation
    };
  }
}
