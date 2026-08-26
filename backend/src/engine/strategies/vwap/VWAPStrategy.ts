import { IStrategy } from '../../interfaces/IStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { EvaluationResult } from '../../dto/EvaluationResult';
import { StrategyManifest } from '../StrategyManifest';
import { IndicatorEngine } from '../../indicator';
import { ConditionEngine } from '../../condition';
import { ConfidenceEngine } from '../../confidence';
import { RiskEngine, RiskContext } from '../../risk';
import { SignalEngine, SignalContext, SignalType } from '../../signal';
import { Timeframe } from '../../market-data/Timeframe';

import { VWAP_STRATEGY_MANIFEST } from './VWAPRules';
import { VWAPConfig, DEFAULT_VWAP_CONFIG } from './VWAPConfig';
import { VWAPCalculator } from './VWAPCalculator';

export class VWAPStrategy implements IStrategy {
  public readonly manifest: StrategyManifest = {
    id: VWAP_STRATEGY_MANIFEST.id,
    displayName: VWAP_STRATEGY_MANIFEST.name,
    description: VWAP_STRATEGY_MANIFEST.description,
    version: VWAP_STRATEGY_MANIFEST.version,
    category: VWAP_STRATEGY_MANIFEST.classification,
    riskProfile: VWAP_STRATEGY_MANIFEST.riskProfile,
    supportedMarkets: ['CRYPTO'],
    supportedTimeframes: VWAP_STRATEGY_MANIFEST.supportedTimeframes as Timeframe[],
    minimumCandles: 200,
    defaultConfiguration: DEFAULT_VWAP_CONFIG,
    supportsLong: true,
    supportsShort: true,
    supportsPaperTrading: true,
    supportsLiveTrading: true,
    status: 'ACTIVE',
    author: VWAP_STRATEGY_MANIFEST.author,
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

  constructor(private config: VWAPConfig = DEFAULT_VWAP_CONFIG) {
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

    const currentCandle = candles[candles.length - 1];
    const previousCandle = candles[candles.length - 2];

    // Guard A — Current price validation
    const currentPrice = currentCandle?.close || context.marketSnapshot.currentPrice || 0;
    const previousPrice = previousCandle?.close || currentPrice;

    if (!currentPrice || currentPrice <= 0) {
      return this.createHoldResult(context, ['Invalid or missing current price'], indicatorSnapshot, conditionResult);
    }

    // Guard B — Account balance validation
    if (!context.accountBalance || context.accountBalance <= 0) {
      return this.createHoldResult(context, ['Account balance is zero or unconfigured'], indicatorSnapshot, conditionResult);
    }

    // Retrieve standard indicators needed for Risk evaluation
    const tfIndicators = indicatorSnapshot.timeframes[timeframeToUse];
    if (!tfIndicators) {
      return this.createHoldResult(context, ['Indicators failed to calculate'], indicatorSnapshot, conditionResult);
    }
    const atrArray = tfIndicators.atr[this.config.conditionConfig.atrPeriod];
    const currentAtr = atrArray ? atrArray[atrArray.length - 1] : 0;

    // -- Strategy Specific Logic: VWAP Calculation & Validation --
    const vwapValues = VWAPCalculator.calculate(candles);
    const currentVwap = vwapValues[vwapValues.length - 1];
    const previousVwap = vwapValues[vwapValues.length - 2];

    // Distance from VWAP Check (Over-extension)
    const deviationPercent = Math.abs(currentPrice - currentVwap) / currentVwap * 100;
    if (deviationPercent > this.config.vwapRules.maxDeviationThresholdPercent) {
      return this.createHoldResult(context, ['Price excessively extended away from VWAP'], indicatorSnapshot, conditionResult);
    }

    // Sideways Chop Check (Minimum Displacement)
    const displacementPercent = Math.abs(currentPrice - previousPrice) / previousPrice * 100;
    if (displacementPercent < this.config.vwapRules.minSidewaysDisplacementPercent) {
      return this.createHoldResult(context, ['No meaningful VWAP displacement (sideways market)'], indicatorSnapshot, conditionResult);
    }

    // Volume Confirmation Check
    let avgVolume = 0;
    if (tfIndicators.volume && tfIndicators.volume.length > 0 && !isNaN(tfIndicators.volume[tfIndicators.volume.length - 1].averageVolume)) {
      avgVolume = tfIndicators.volume[tfIndicators.volume.length - 1].averageVolume;
    } else {
      avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
    }

    if (currentCandle.volume < avgVolume * this.config.vwapRules.minVolumeMultiplier) {
      return this.createHoldResult(context, ['Low volume rejection (volume confirmation not met)'], indicatorSnapshot, conditionResult);
    }

    // Identify interactions with VWAP (Crossovers)
    const crossedAboveVwap = previousPrice <= previousVwap && currentPrice > currentVwap;
    const crossedBelowVwap = previousPrice >= previousVwap && currentPrice < currentVwap;

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

    const baseSignal = this.signalEngine.evaluate(
      signalContext,
      conditionResult,
      confidenceScore,
      riskAssessment
    );

    let finalSignalType = SignalType.HOLD;
    const reasoning = [...baseSignal.reasoning];

    if (crossedAboveVwap) {
      finalSignalType = SignalType.BUY;
      reasoning.push('VWAP: Strong volume crossover above fair value');
    } else if (crossedBelowVwap) {
      if (this.manifest.supportsShort) {
        finalSignalType = SignalType.SELL;
        reasoning.push('VWAP: Strong volume crossover below fair value');
      } else {
        reasoning.push('VWAP: Bearish setup detected but shorting is disabled');
      }
    } else {
      return this.createHoldResult(context, ['No definitive VWAP crossover'], indicatorSnapshot, conditionResult);
    }

    if (confidenceScore.overallScore < this.config.signalRules.minConfidenceScore) {
      finalSignalType = SignalType.HOLD;
      reasoning.push('Confidence below threshold');
    }

    const volMultiplier = avgVolume > 0 ? (currentCandle.volume / avgVolume) : 1.0;
    const customIndicators = [
      { name: 'VWAP Fair Value', value: `$${currentVwap.toFixed(2)}`, signal: currentPrice > currentVwap ? 'BULLISH' : 'BEARISH' },
      { name: 'VWAP Deviation', value: `${deviationPercent.toFixed(2)}%`, signal: deviationPercent <= this.config.vwapRules.maxDeviationThresholdPercent ? 'BULLISH' : 'BEARISH' },
      { name: 'Volume Multiplier', value: `${volMultiplier.toFixed(2)}x`, signal: volMultiplier >= this.config.vwapRules.minVolumeMultiplier ? 'BULLISH' : 'NEUTRAL' },
      { name: 'Price Displacement', value: `${displacementPercent.toFixed(2)}%`, signal: displacementPercent >= this.config.vwapRules.minSidewaysDisplacementPercent ? 'BULLISH' : 'NEUTRAL' }
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
