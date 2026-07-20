import { IStrategy } from '../../interfaces/IStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { EvaluationResult } from '../../dto/EvaluationResult';
import { ScalperV2Config, DEFAULT_SCALPER_CONFIG } from './ScalperV2Config';

import { IndicatorEngine } from '../../indicator/IndicatorEngine';
import { ConditionEngine } from '../../condition/ConditionEngine';
import { ConfidenceEngine } from '../../confidence/ConfidenceEngine';
import { RiskEngine, RiskContext } from '../../risk';
import { SignalEngine, SignalContext, SignalType } from '../../signal';

export class ScalperV2Strategy implements IStrategy {
  private indicatorEngine: IndicatorEngine;
  private conditionEngine: ConditionEngine;
  private confidenceEngine: ConfidenceEngine;
  private riskEngine: RiskEngine;
  private signalEngine: SignalEngine;

  constructor(private config: ScalperV2Config = DEFAULT_SCALPER_CONFIG) {
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

    // Default primary timeframe for scalping is 5m
    const primaryTimeframe = '5m';
    
    // Fallback if 5m isn't available
    const timeframeToUse = (context.marketSnapshot.candles[primaryTimeframe] 
      ? primaryTimeframe 
      : Object.keys(context.marketSnapshot.candles)[0]) as import('../../market-data/Timeframe').Timeframe;
      
    if (!timeframeToUse) {
      return {
        strategyId: 'scalper-v2',
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ['No market data timeframes available'] }
      };
    }

    const candles = context.marketSnapshot.candles[timeframeToUse];
    const currentPrice = candles[candles.length - 1]?.close || 0;
    
    // Safely retrieve ATR, assuming it was calculated
    const tfIndicators = indicatorSnapshot.timeframes[timeframeToUse];
    const atrArray = tfIndicators?.atr[this.config.conditionConfig.atrPeriod];
    const currentAtr = atrArray ? atrArray[atrArray.length - 1] : 0;

    // 4. Risk
    const riskContext: RiskContext = {
      timestamp: context.timestamp,
      currentPrice,
      currentAtr,
      // For this stateless evaluation, assume a dummy account balance 
      // or pass it through a modified context if it existed. 
      // Since context currently only has marketSnapshot, we use a default
      accountBalance: 1000 
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
      strategyId: 'scalper-v2',
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
