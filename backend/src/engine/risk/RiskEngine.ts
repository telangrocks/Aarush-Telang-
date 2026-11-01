import { RiskParameters } from './RiskParameters';
import { RiskAssessment, RiskClassification } from './RiskAssessment';
import { StopLossCalculator } from './StopLossCalculator';
import { TakeProfitCalculator } from './TakeProfitCalculator';
import { OrderSizing } from './OrderSizing';

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
    const maxAllowedExposure = (Number.isFinite(context.accountBalance) && context.accountBalance > 0)
      ? context.accountBalance * (this.config.maxExposureLimit / 100)
      : 0;

    // Defensive validation: fail closed on non-finite, zero, or negative required inputs
    if (
      !Number.isFinite(context.currentPrice) ||
      context.currentPrice <= 0 ||
      !Number.isFinite(stopLossDistance) ||
      stopLossDistance <= 0
    ) {
      const riskClassification: RiskClassification = 'EXTREME';
      explanation.push('Invalid or non-positive required inputs for risk calculation: fail closed to EXTREME with 0 position size.');

      return {
        timestamp: context.timestamp,
        stopLossDistance: Number.isFinite(stopLossDistance) ? stopLossDistance : 0,
        takeProfitDistance: Number.isFinite(takeProfitDistance) ? takeProfitDistance : 0,
        riskRewardRatio: tpMultiplier,
        positionSizeRecommendation: 0,
        maximumExposure: maxAllowedExposure,
        riskClassification,
        explanation
      };
    }

    // Assess dynamic risk classification based on stop loss distance percentage
    const stopLossPercent = (stopLossDistance / context.currentPrice) * 100;
    let riskClassification: RiskClassification = 'LOW';

    if (stopLossPercent >= 12.0) {
      riskClassification = 'EXTREME';
      explanation.push(`Risk classification is EXTREME (Stop Loss distance is ${stopLossPercent.toFixed(2)}% of entry price >= 12.0%).`);
    } else if (stopLossPercent >= 8.0) {
      riskClassification = 'HIGH';
      explanation.push(`Risk classification is HIGH (Stop Loss distance is ${stopLossPercent.toFixed(2)}% of entry price >= 8.0%).`);
    } else if (stopLossPercent >= 5.0) {
      riskClassification = 'MEDIUM';
      explanation.push(`Risk classification is MEDIUM (Stop Loss distance is ${stopLossPercent.toFixed(2)}% of entry price >= 5.0%).`);
    } else {
      riskClassification = 'LOW';
      explanation.push(`Risk classification is LOW (Stop Loss distance is ${stopLossPercent.toFixed(2)}% of entry price < 5.0%).`);
    }

    const positionSizeRecommendation = OrderSizing.calculateSize(
      context.accountBalance,
      stopLossDistance,
      context.currentPrice,
      this.config
    );

    return {
      timestamp: context.timestamp,
      stopLossDistance,
      takeProfitDistance,
      riskRewardRatio: tpMultiplier, // Legacy interface telemetry property
      positionSizeRecommendation,
      maximumExposure: maxAllowedExposure,
      riskClassification,
      explanation
    };
  }
}
