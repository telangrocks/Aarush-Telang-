import { IStrategy } from '../../interfaces/IStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { EvaluationResult } from '../../dto/EvaluationResult';
import { StrategyManifest } from '../StrategyManifest';
import { IndicatorEngine } from '../../indicator';
import { ConditionEngine } from '../../condition';
import { ConfidenceEngine } from '../../confidence';
import { RiskEngine, RiskContext } from '../../risk';
import { SignalEngine, SignalContext, SignalType } from '../../signal';

import { MEAN_REVERSION_STRATEGY_MANIFEST } from './MeanReversionRules';
import { MeanReversionConfig, DEFAULT_MEAN_REVERSION_CONFIG } from './MeanReversionConfig';
import { Timeframe } from '../../market-data/Timeframe';

export class MeanReversionStrategy implements IStrategy {
  public readonly manifest: StrategyManifest = {
    id: MEAN_REVERSION_STRATEGY_MANIFEST.id,
    displayName: MEAN_REVERSION_STRATEGY_MANIFEST.name,
    description: MEAN_REVERSION_STRATEGY_MANIFEST.description,
    version: MEAN_REVERSION_STRATEGY_MANIFEST.version,
    category: MEAN_REVERSION_STRATEGY_MANIFEST.classification,
    riskProfile: MEAN_REVERSION_STRATEGY_MANIFEST.riskProfile,
    supportedMarkets: ['CRYPTO'],
    supportedTimeframes: MEAN_REVERSION_STRATEGY_MANIFEST.supportedTimeframes as Timeframe[],
    minimumCandles: 200,
    defaultConfiguration: DEFAULT_MEAN_REVERSION_CONFIG,
    supportsLong: true,
    supportsShort: true,
    supportsPaperTrading: true,
    supportsLiveTrading: true,
    status: 'ACTIVE',
    author: MEAN_REVERSION_STRATEGY_MANIFEST.author,
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

  constructor(private config: MeanReversionConfig = DEFAULT_MEAN_REVERSION_CONFIG) {
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

    // Guard C — Dynamic timeframe selection & candle validation
    const primaryTimeframe = (this.config.preferredTimeframes?.[0] || '15m') as Timeframe;
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
    const currentCandle = candles[candles.length - 1];
    const currentPrice = currentCandle?.close || context.marketSnapshot.currentPrice || 0;

    if (!currentPrice || currentPrice <= 0) {
      return this.createHoldResult(context, ['Invalid or missing current price'], indicatorSnapshot, conditionResult);
    }

    // Guard B — Account balance validation
    if (!context.accountBalance || context.accountBalance <= 0) {
      return this.createHoldResult(context, ['Account balance is zero or unconfigured'], indicatorSnapshot, conditionResult);
    }

    const tfIndicators = indicatorSnapshot.timeframes[timeframeToUse];
    if (!tfIndicators) {
      return this.createHoldResult(context, ['Indicators failed to calculate'], indicatorSnapshot, conditionResult);
    }

    // -- Strategy Specific Logic: Trend Strength Filter --
    const { emaFastPeriod, emaSlowPeriod, rsiPeriod } = this.config.conditionConfig;
    const emaFast = tfIndicators.ema[emaFastPeriod];
    const emaSlow = tfIndicators.ema[emaSlowPeriod];
    const rsi = tfIndicators.rsi[rsiPeriod];
    const atrArray = tfIndicators.atr[this.config.conditionConfig.atrPeriod];

    if (!emaFast || !emaSlow || !rsi || !atrArray) {
      return this.createHoldResult(context, ['Required indicators missing'], indicatorSnapshot, conditionResult);
    }

    const currentEmaFast = emaFast[emaFast.length - 1];
    const currentEmaSlow = emaSlow[emaSlow.length - 1];
    const previousRsi = rsi[rsi.length - 2];
    const currentRsi = rsi[rsi.length - 1];
    const currentAtr = atrArray[atrArray.length - 1];

    const emaSeparation = Math.abs(currentEmaFast - currentEmaSlow) / currentEmaSlow * 100;
    if (emaSeparation > this.config.trendFilter.maxEmaSeparationPercent) {
      return this.createHoldResult(context, ['Strong trend detected (EMA separation too large)'], indicatorSnapshot, conditionResult);
    }

    // -- Strategy Specific Logic: 2-Step Confirmation --
    let isReversingFromOversold = false;
    let isReversingFromOverbought = false;

    if (this.config.entryRules.requireTwoStepConfirmation) {
      // Step 1: Was previously extreme
      const wasOversold = previousRsi <= this.config.conditionConfig.rsiOversold;
      const wasOverbought = previousRsi >= this.config.conditionConfig.rsiOverbought;
      
      // Step 2: Now curling back
      isReversingFromOversold = wasOversold && currentRsi > previousRsi;
      isReversingFromOverbought = wasOverbought && currentRsi < previousRsi;
      
      if (!isReversingFromOversold && !isReversingFromOverbought) {
        return this.createHoldResult(context, ['No reversal confirmation (2-step check failed)'], indicatorSnapshot, conditionResult);
      }
    } else {
      isReversingFromOversold = currentRsi <= this.config.conditionConfig.rsiOversold;
      isReversingFromOverbought = currentRsi >= this.config.conditionConfig.rsiOverbought;
      if (!isReversingFromOversold && !isReversingFromOverbought) {
        return this.createHoldResult(context, ['RSI not at extremes'], indicatorSnapshot, conditionResult);
      }
    }

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

    // Override or refine the trading signal based on our hard mean reversion logic
    const baseSignal = this.signalEngine.evaluate(
      signalContext,
      conditionResult,
      confidenceScore,
      riskAssessment
    );

    // Enforce our directional bias from the reversal
    let finalSignalType = SignalType.HOLD;
    const reasoning = [...baseSignal.reasoning];

    if (isReversingFromOversold) {
      finalSignalType = SignalType.BUY;
      reasoning.push('Mean Reversion: Buy setup confirmed via oversold bounce');
    } else if (isReversingFromOverbought) {
      // If shorting is allowed
      if (this.manifest.supportsShort) {
        finalSignalType = SignalType.SELL;
        reasoning.push('Mean Reversion: Sell setup confirmed via overbought rejection');
      } else {
        reasoning.push('Mean Reversion: Sell setup detected but shorting is disabled');
      }
    }

    // Apply confidence threshold from config
    if (confidenceScore.overallScore < this.config.signalRules.minConfidenceScore) {
      finalSignalType = SignalType.HOLD;
      reasoning.push('Confidence below threshold');
    }

    const customIndicators = [
      { name: 'EMA Separation', value: `${emaSeparation.toFixed(2)}%`, signal: emaSeparation <= this.config.trendFilter.maxEmaSeparationPercent ? 'BULLISH' : 'BEARISH' },
      { name: '2-Step Reversal', value: isReversingFromOversold ? 'Oversold Bounce' : isReversingFromOverbought ? 'Overbought Rejection' : 'Neutral', signal: isReversingFromOversold ? 'BULLISH' : isReversingFromOverbought ? 'BEARISH' : 'NEUTRAL' }
    ];

    return {
      strategyId: this.manifest.id,
      timestamp: context.timestamp,
      confidenceScore: confidenceScore.overallScore,
      hasSignal: finalSignalType !== SignalType.HOLD,
      metadata: {
        reasoning,
        signal: {
          ...baseSignal,
          type: finalSignalType,
          reasoning
        },
        indicatorSnapshot,
        conditionResult,
        confidenceScore,
        strategyConfig: this.config,
        customIndicators
      }
    };
  }

  private createHoldResult(
    context: Readonly<StrategyContext>,
    reasoning: string[],
    indicatorSnapshot?: any,
    conditionResult?: any,
    customIndicators?: any[]
  ): EvaluationResult {
    return {
      strategyId: this.manifest.id,
      timestamp: context.timestamp,
      confidenceScore: 0,
      hasSignal: false,
      metadata: {
        reasoning,
        indicatorSnapshot: indicatorSnapshot || { timestamp: context.timestamp, timeframes: {} },
        conditionResult: conditionResult || { timestamp: context.timestamp, overallPass: false, totalConditions: 0, passedConditions: 0, conditions: [] },
        strategyConfig: this.config,
        customIndicators: customIndicators || []
      }
    };
  }
}
