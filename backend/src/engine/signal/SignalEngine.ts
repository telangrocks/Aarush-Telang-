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

    // Fail closed if market conditions on trigger timeframe are completely neutral
    const tfCondition = conditionResult?.timeframes?.[context.timeframe];
    if (
      tfCondition &&
      tfCondition.trend?.trendDirection === 'SIDEWAYS' &&
      tfCondition.trend?.emaCrossoverState === 'NONE' &&
      tfCondition.momentum?.macdDirection === 'NEUTRAL' &&
      tfCondition.momentum?.rsiState === 'NEUTRAL'
    ) {
      return null;
    }

    // Model C Directional Arbitration:
    // BUY only when long qualifies (longScore >= minConfidenceScore) and short does not (shortScore < minConfidenceScore).
    // SELL only when short qualifies (shortScore >= minConfidenceScore) and long does not (longScore < minConfidenceScore).
    // Return null when both or neither qualify.
    let proposedType: SignalType | null = null;
    const { longScore, shortScore } = tfConfidence;

    if (typeof longScore === 'number' && typeof shortScore === 'number') {
      const minConf = this.rules.minConfidenceScore;
      const isLongQualified = longScore >= minConf && shortScore < minConf;
      const isShortQualified = shortScore >= minConf && longScore < minConf;

      if (isLongQualified) {
        proposedType = SignalType.BUY;
      } else if (isShortQualified) {
        proposedType = SignalType.SELL;
      } else {
        return null;
      }
    } else {
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
