import { IStrategy } from '../../interfaces/IStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { EvaluationResult } from '../../dto/EvaluationResult';
import { MomentumConfig, DEFAULT_MOMENTUM_CONFIG } from './MomentumConfig';
import { MOMENTUM_STRATEGY_MANIFEST } from './MomentumRules';

import { IndicatorEngine } from '../../indicator/IndicatorEngine';
import { ConditionEngine } from '../../condition/ConditionEngine';
import { ConfidenceEngine } from '../../confidence/ConfidenceEngine';
import { RiskEngine, RiskContext } from '../../risk';
import { SignalEngine, SignalContext, SignalType } from '../../signal';

export class MomentumStrategy implements IStrategy {
  private indicatorEngine: IndicatorEngine;
  private conditionEngine: ConditionEngine;
  private confidenceEngine: ConfidenceEngine;
  private riskEngine: RiskEngine;
  private signalEngine: SignalEngine;

  constructor(private config: MomentumConfig = DEFAULT_MOMENTUM_CONFIG) {
    this.indicatorEngine = new IndicatorEngine(config.indicatorConfig);
    this.conditionEngine = new ConditionEngine(config.conditionConfig);
    this.confidenceEngine = new ConfidenceEngine(config.confidenceWeights);
    this.riskEngine = new RiskEngine(config.riskParameters);
    this.signalEngine = new SignalEngine(config.signalRules);
  }

  public evaluate(context: Readonly<StrategyContext>): EvaluationResult {
    // 1. Indicators
    const indicatorSnapshot = this.indicatorEngine.evaluate(context.marketSnapshot);

    // 2. Conditions
    const conditionResult = this.conditionEngine.evaluate(indicatorSnapshot);

    // 3. Confidence
    const confidenceScore = this.confidenceEngine.evaluate(conditionResult);

    // Default primary timeframe for momentum is usually larger, e.g. 15m or 1h
    const primaryTimeframe = '1h';
    
    // Fallback if primary isn't available
    const timeframeToUse = (context.marketSnapshot.candles[primaryTimeframe] 
      ? primaryTimeframe 
      : Object.keys(context.marketSnapshot.candles)[0]) as import('../../market-data/Timeframe').Timeframe;
      
    if (!timeframeToUse) {
      return {
        strategyId: MOMENTUM_STRATEGY_MANIFEST.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ['No market data timeframes available'] }
      };
    }

    const candles = context.marketSnapshot.candles[timeframeToUse];
    const currentPrice = candles[candles.length - 1]?.close || 0;
    
    const tfIndicators = indicatorSnapshot.timeframes[timeframeToUse];
    const atrArray = tfIndicators?.atr[this.config.conditionConfig.atrPeriod];
    const currentAtr = atrArray ? atrArray[atrArray.length - 1] : 0;

    // 4. Risk
    const riskContext: RiskContext = {
      timestamp: context.timestamp,
      currentPrice,
      currentAtr,
      accountBalance: 1000 // Placeholder for standard calculation
    };
    const riskAssessment = this.riskEngine.evaluate(riskContext);

    // 5. Signal
    const signalContext: SignalContext = {
      symbol: context.marketSnapshot.symbol,
      timeframe: timeframeToUse,
      currentPrice
    };

    const tradingSignal = this.signalEngine.evaluate(
      signalContext,
      conditionResult,
      confidenceScore,
      riskAssessment
    );

    return {
      strategyId: MOMENTUM_STRATEGY_MANIFEST.id,
      timestamp: context.timestamp,
      confidenceScore: tradingSignal.confidenceScore,
      hasSignal: tradingSignal.type !== SignalType.HOLD,
      metadata: {
        reasoning: tradingSignal.reasoning,
        signal: tradingSignal
      }
    };
  }
}
