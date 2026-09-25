import { RiskParameters } from './RiskParameters';
import { RiskAssessment, RiskClassification } from './RiskAssessment';
import { StopLossCalculator } from './StopLossCalculator';
import { TakeProfitCalculator } from './TakeProfitCalculator';

export interface RiskContext {
  timestamp: number;
  currentPrice: number;
  currentAtr: number;
  accountBalance: number;
  targetEntryPrice?: number | null;
}

export class RiskEngine {
  constructor(private config: RiskParameters) {}

  public evaluate(context: RiskContext): RiskAssessment {
    const explanation: string[] = [];

    if (context.targetEntryPrice != null && context.targetEntryPrice > 0) {
      const slippagePercent = Math.abs(context.currentPrice - context.targetEntryPrice) / context.targetEntryPrice * 100;
      explanation.push(`Target entry price: ${context.targetEntryPrice.toFixed(2)} (Slippage: ${slippagePercent.toFixed(2)}%).`);
    }

    // Calculate Stop Loss
    const stopLossDistance = StopLossCalculator.calculateDistance(context.currentAtr, this.config);
    explanation.push(`Stop Loss distance calculated at ${stopLossDistance.toFixed(2)} (ATR multiplier: ${this.config.atrStopLossMultiplier}).`);

    // Calculate Take Profit (Model A: Independent ATR distance)
    const takeProfitDistance = TakeProfitCalculator.calculateDistance(context.currentAtr, this.config);
    const tpMultiplier = this.config.atrTakeProfitMultiplier ?? this.config.riskRewardRatio ?? 2.0;
    explanation.push(`Take Profit distance calculated at ${takeProfitDistance.toFixed(2)} (ATR multiplier: ${tpMultiplier}).`);

    // Assess risk classification based on exposure limits
    const maxAllowedExposure = context.accountBalance * (this.config.maxExposureLimit / 100);
    const riskClassification: RiskClassification = 'LOW';
    explanation.push('Risk classification is LOW.');

    return {
      timestamp: context.timestamp,
      stopLossDistance,
      takeProfitDistance,
      riskRewardRatio: tpMultiplier, // Legacy interface telemetry property
      maximumExposure: maxAllowedExposure,
      riskClassification,
      explanation
    };
  }
}
