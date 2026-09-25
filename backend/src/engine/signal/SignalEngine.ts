import { ConditionResult } from '../condition';
import { ConfidenceScore } from '../confidence';
import { RiskAssessment } from '../risk';
import { SignalType } from './SignalType';
import { TradingSignal, SignalContext } from './TradingSignal';
import { SignalValidator, SignalRules } from './SignalValidator';

export class SignalEngine {
  private validator: SignalValidator;
  private rules: SignalRules;

  constructor(rules: SignalRules) {
    this.rules = rules;
    this.validator = new SignalValidator(rules);
  }

  public evaluate(
    context: SignalContext,
    conditionResult: ConditionResult,
    confidenceScore: ConfidenceScore,
    riskAssessment: RiskAssessment
  ): TradingSignal | null {
    const tfConfidence = confidenceScore.timeframes[context.timeframe];

    if (!tfConfidence) {
      return null;
    }

    // A signal direction is usually determined by the strategy/condition, but in a generic 
    // engine layer, we rely on the condition result or confidence factors. 
    // Infer direction from the conditionResult's trend.
    const tfCondition = conditionResult.timeframes[context.timeframe];
    let proposedType: SignalType | null = null;
    if (tfCondition) {
      if (tfCondition.trend.trendDirection === 'UP' || tfCondition.trend.emaCrossoverState === 'BULLISH') {
        proposedType = SignalType.BUY;
      } else if (tfCondition.trend.trendDirection === 'DOWN' || tfCondition.trend.emaCrossoverState === 'BEARISH') {
        proposedType = SignalType.SELL;
      }
    }

    if (!proposedType) {
      return null;
    }

    const { isValid, reasoning } = this.validator.validate(tfConfidence, riskAssessment, proposedType);

    if (!isValid) {
      return null;
    }

    const stopLoss = proposedType === SignalType.BUY 
      ? context.currentPrice - riskAssessment.stopLossDistance
      : context.currentPrice + riskAssessment.stopLossDistance;

    const takeProfit = proposedType === SignalType.BUY
      ? context.currentPrice + riskAssessment.takeProfitDistance
      : context.currentPrice - riskAssessment.takeProfitDistance;

    const directionalScore = proposedType === SignalType.SELL
      ? (typeof tfConfidence.shortScore === 'number' ? tfConfidence.shortScore : tfConfidence.score)
      : (typeof tfConfidence.longScore === 'number' ? tfConfidence.longScore : tfConfidence.score);

    return {
      symbol: context.symbol,
      timeframe: context.timeframe,
      type: proposedType,
      confidenceScore: directionalScore,
      riskAssessment,
      signalPrice: context.currentPrice,
      targetEntryPrice: context.targetEntryPrice ?? null,
      entryPrice: context.currentPrice,
      stopLoss,
      takeProfit,
      reasoning: [
        `Valid ${proposedType} signal generated based on strong conditions.`,
        ...reasoning
      ],
      timestamp: confidenceScore.timestamp
    };
  }
}
