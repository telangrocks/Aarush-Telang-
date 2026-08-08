import { IStrategy } from '../../interfaces/IStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { EvaluationResult } from '../../dto/EvaluationResult';
import { StrategyManifest } from '../StrategyManifest';
import { IndicatorEngine } from '../../indicator';
import { ConditionEngine } from '../../condition';
import { ConfidenceEngine } from '../../confidence';
import { RiskEngine, RiskContext } from '../../risk';
import { SignalEngine, SignalContext, SignalType } from '../../signal';

import { BREAKOUT_STRATEGY_MANIFEST } from './BreakoutRules';
import { BreakoutConfig, DEFAULT_BREAKOUT_CONFIG } from './BreakoutConfig';
import { Timeframe } from '../../market-data/Timeframe';

export class BreakoutStrategy implements IStrategy {
  public readonly manifest: StrategyManifest = {
    id: BREAKOUT_STRATEGY_MANIFEST.id,
    displayName: BREAKOUT_STRATEGY_MANIFEST.name,
    description: BREAKOUT_STRATEGY_MANIFEST.description,
    version: BREAKOUT_STRATEGY_MANIFEST.version,
    category: BREAKOUT_STRATEGY_MANIFEST.classification,
    riskProfile: BREAKOUT_STRATEGY_MANIFEST.riskProfile,
    supportedMarkets: ['CRYPTO'],
    supportedTimeframes: BREAKOUT_STRATEGY_MANIFEST.supportedTimeframes as Timeframe[],
    minimumCandles: 200,
    defaultConfiguration: DEFAULT_BREAKOUT_CONFIG,
    supportsLong: true,
    supportsShort: false,
    supportsPaperTrading: true,
    supportsLiveTrading: true,
    status: 'ACTIVE',
    author: BREAKOUT_STRATEGY_MANIFEST.author,
    parameters: [
      { key: 'risk_level', displayName: 'Risk Level', type: 'ENUM', defaultValue: 'Medium', isRequired: true, options: ['Low', 'Medium', 'High'] },
      { key: 'mode', displayName: 'Mode', type: 'ENUM', defaultValue: 'Aggressive', isRequired: true, options: ['Conservative', 'Moderate', 'Aggressive'] }
    ]
  };

  private indicatorEngine: IndicatorEngine;
  private conditionEngine: ConditionEngine;
  private confidenceEngine: ConfidenceEngine;
  private riskEngine: RiskEngine;
  private signalEngine: SignalEngine;

  constructor(private config: BreakoutConfig = DEFAULT_BREAKOUT_CONFIG) {
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

    // Guard C — Candle timeframe resolution and candle availability check
    const primaryTimeframe = (this.config.preferredTimeframes?.[0] || '1h') as Timeframe;
    const availableTimeframes = Object.keys(context.marketSnapshot.candles || {});
    const timeframeToUse = (context.marketSnapshot.candles?.[primaryTimeframe]
      ? primaryTimeframe
      : availableTimeframes[0]) as Timeframe;

    if (!timeframeToUse || !context.marketSnapshot.candles?.[timeframeToUse] || context.marketSnapshot.candles[timeframeToUse].length === 0) {
      return this.createHoldResult(context, ['No candle data available for any timeframe'], indicatorSnapshot, conditionResult);
    }

    const candles = context.marketSnapshot.candles[timeframeToUse];
    if (candles.length < 2) {
      return this.createHoldResult(context, ['Insufficient candle data for analysis'], indicatorSnapshot, conditionResult);
    }

    // Guard A — Current price validation
    const latestCandleClose = candles[candles.length - 1]?.close || 0;
    const currentPrice = (latestCandleClose > 0)
      ? latestCandleClose
      : context.marketSnapshot.currentPrice || 0;

    if (!currentPrice || currentPrice <= 0) {
      return this.createHoldResult(context, ['Invalid or missing current price'], indicatorSnapshot, conditionResult);
    }

    // Guard B — Account balance validation
    if (!context.accountBalance || context.accountBalance <= 0) {
      return this.createHoldResult(context, ['Account balance is zero or unconfigured'], indicatorSnapshot, conditionResult);
    }

    const tfIndicators = indicatorSnapshot.timeframes[timeframeToUse];
    const atrArray = tfIndicators?.atr[this.config.conditionConfig.atrPeriod];
    const currentAtr = atrArray ? atrArray[atrArray.length - 1] : 0;

    // 4. Risk
    const riskContext: RiskContext = {
      timestamp: context.timestamp,
      currentPrice,
      currentAtr,
      accountBalance: context.accountBalance
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
      strategyId: this.manifest.id,
      timestamp: context.timestamp,
      confidenceScore: tradingSignal.confidenceScore,
      hasSignal: tradingSignal.type !== SignalType.HOLD,
      metadata: {
        reasoning: tradingSignal.reasoning,
        signal: tradingSignal,
        indicatorSnapshot,
        conditionResult
      }
    };
  }

  private createHoldResult(
    context: Readonly<StrategyContext>,
    reasoning: string[],
    indicatorSnapshot?: any,
    conditionResult?: any
  ): EvaluationResult {
    return {
      strategyId: this.manifest.id,
      timestamp: context.timestamp,
      confidenceScore: 0,
      hasSignal: false,
      metadata: {
        reasoning,
        indicatorSnapshot: indicatorSnapshot || { timestamp: context.timestamp, timeframes: {} },
        conditionResult: conditionResult || { timestamp: context.timestamp, overallPass: false, totalConditions: 0, passedConditions: 0, conditions: [] }
      }
    };
  }
}
