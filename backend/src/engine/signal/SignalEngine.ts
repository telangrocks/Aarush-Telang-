import { ConditionResult } from '../condition';
import { ConfidenceScore } from '../confidence';
import { RiskAssessment } from '../risk';
import { SignalType } from './SignalType';
import { TradingSignal, SignalContext } from './TradingSignal';
import { SignalValidator, SignalRules } from './SignalValidator';

export class SignalEngine {
  private validator: SignalValidator;

  constructor(rules: SignalRules) {
    this.validator = new SignalValidator(rules);
  }

  public evaluate(
    context: SignalContext,
    conditionResult: ConditionResult,
    confidenceScore: ConfidenceScore,
    riskAssessment: RiskAssessment
  ): TradingSignal {
    const tfConfidence = confidenceScore.timeframes[context.timeframe];

    if (!tfConfidence) {
      return this.createHoldSignal(
        context, 
        confidenceScore.timestamp, 
        ['Timeframe confidence data is missing.']
      );
    }

    // A signal direction is usually determined by the strategy/condition, but in a generic 
    // engine layer, we rely on the condition result or confidence factors. 
    // For this generic Signal Engine Sprint, we'll infer direction from the trend conditions or 
    // assume it's passed in. Let's infer from the conditionResult's trend.
    const tfCondition = conditionResult.timeframes[context.timeframe];
    let proposedType: SignalType = SignalType.HOLD;
    if (tfCondition) {
      if (tfCondition.trend.trendDirection === 'UP' || tfCondition.trend.emaCrossoverState === 'BULLISH') {
        proposedType = SignalType.BUY;
      } else if (tfCondition.trend.trendDirection === 'DOWN' || tfCondition.trend.emaCrossoverState === 'BEARISH') {
        proposedType = SignalType.SELL;
      }
    }

    if (proposedType === SignalType.HOLD) {
       return this.createHoldSignal(
        context, 
        confidenceScore.timestamp, 
        ['No strong directional bias found in conditions.']
      );
    }

    const { isValid, reasoning } = this.validator.validate(tfConfidence, riskAssessment);

    if (!isValid) {
      return this.createHoldSignal(context, confidenceScore.timestamp, reasoning);
    }

    const stopLoss = proposedType === SignalType.BUY 
      ? context.currentPrice - riskAssessment.stopLossDistance
      : context.currentPrice + riskAssessment.stopLossDistance;

    const takeProfit = proposedType === SignalType.BUY
      ? context.currentPrice + riskAssessment.takeProfitDistance
      : context.currentPrice - riskAssessment.takeProfitDistance;

    return {
      symbol: context.symbol,
      timeframe: context.timeframe,
      type: proposedType,
      confidenceScore: tfConfidence.score,
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

  private createHoldSignal(context: SignalContext, timestamp: number, reasoning: string[]): TradingSignal {
    return {
      symbol: context.symbol,
      timeframe: context.timeframe,
      type: SignalType.HOLD,
      confidenceScore: 0,
      riskAssessment: null,
      signalPrice: null,
      targetEntryPrice: context.targetEntryPrice ?? null,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      reasoning,
      timestamp
    };
  }
}
