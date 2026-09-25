import { IStrategy } from '../../interfaces/IStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { EvaluationResult } from '../../dto/EvaluationResult';
import { StrategyManifest } from '../StrategyManifest';
import { IndicatorEngine } from '../../indicator';
import { ConditionEngine } from '../../condition';
import { ConfidenceEngine } from '../../confidence';
import { RiskEngine, RiskContext } from '../../risk';
import { SignalType, TradingSignal } from '../../signal';
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

  constructor(private config: VWAPConfig = DEFAULT_VWAP_CONFIG) {
    this.indicatorEngine = new IndicatorEngine(config.indicatorConfig);
    this.conditionEngine = new ConditionEngine(config.conditionConfig);
    this.confidenceEngine = new ConfidenceEngine(config.confidenceWeights);
    this.riskEngine = new RiskEngine(config.riskParameters);
  }

  public evaluate(context: Readonly<StrategyContext>): EvaluationResult {
    // 1. Indicators
    const indicatorSnapshot = this.indicatorEngine.evaluate(context.marketSnapshot);

    // 2. Conditions
    const conditionResult = this.conditionEngine.evaluate(indicatorSnapshot);

    // 3. Confidence
    const confidenceScore = this.confidenceEngine.evaluate(conditionResult);

    // Guard C — Option A: Strictly enforce 15m authoritative timeframe without silent fallback
    const timeframeToUse: Timeframe = '15m';
    const candles = context.marketSnapshot.candles?.[timeframeToUse];

    if (!candles || candles.length === 0) {
      return this.createNoSignalResult(context, ['Authoritative 15m candle data is unavailable (Option A strict gate)'], indicatorSnapshot, conditionResult);
    }

    if (candles.length < 2) {
      return this.createNoSignalResult(context, ['Insufficient candle data for analysis'], indicatorSnapshot, conditionResult);
    }

    const currentCandle = candles[candles.length - 1];
    const previousCandle = candles[candles.length - 2];

    // Guard A — Current price validation
    const currentPrice = currentCandle?.close || context.marketSnapshot.currentPrice || 0;
    const previousPrice = previousCandle?.close || currentPrice;

    if (!currentPrice || currentPrice <= 0) {
      return this.createNoSignalResult(context, ['Invalid or missing current price'], indicatorSnapshot, conditionResult);
    }

    // Guard B — Account balance validation
    if (!context.accountBalance || context.accountBalance <= 0) {
      return this.createNoSignalResult(context, ['Account balance is zero or unconfigured'], indicatorSnapshot, conditionResult);
    }

    // Retrieve standard indicators needed for Risk evaluation
    const tfIndicators = indicatorSnapshot.timeframes[timeframeToUse];
    if (!tfIndicators) {
      return this.createNoSignalResult(context, ['Indicators failed to calculate'], indicatorSnapshot, conditionResult);
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
      return this.createNoSignalResult(context, ['Price excessively extended away from VWAP'], indicatorSnapshot, conditionResult);
    }

    // Sideways Chop Check (Minimum Displacement)
    const displacementPercent = Math.abs(currentPrice - previousPrice) / previousPrice * 100;
    if (displacementPercent < this.config.vwapRules.minSidewaysDisplacementPercent) {
      return this.createNoSignalResult(context, ['No meaningful VWAP displacement (sideways market)'], indicatorSnapshot, conditionResult);
    }

    // Volume Confirmation Check
    let avgVolume = 0;
    if (tfIndicators.volume && tfIndicators.volume.length > 0 && !isNaN(tfIndicators.volume[tfIndicators.volume.length - 1].averageVolume)) {
      avgVolume = tfIndicators.volume[tfIndicators.volume.length - 1].averageVolume;
    } else {
      avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
    }

    if (currentCandle.volume < avgVolume * this.config.vwapRules.minVolumeMultiplier) {
      return this.createNoSignalResult(context, ['Low volume rejection (volume confirmation not met)'], indicatorSnapshot, conditionResult);
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

    // 5. Signal — The strategy's own crossover logic is authoritative for direction
    let finalSignalType: SignalType | null = null;
    const reasoning: string[] = [];

    const volMultiplier = avgVolume > 0 ? (currentCandle.volume / avgVolume) : 1.0;
    const customIndicators = [
      { name: 'VWAP Fair Value', value: `$${currentVwap.toFixed(2)}`, signal: currentPrice > currentVwap ? 'BULLISH' : 'BEARISH' },
      { name: 'VWAP Deviation', value: `${deviationPercent.toFixed(2)}%`, signal: deviationPercent <= this.config.vwapRules.maxDeviationThresholdPercent ? 'BULLISH' : 'BEARISH' },
      { name: 'Volume Multiplier', value: `${volMultiplier.toFixed(2)}x`, signal: volMultiplier >= this.config.vwapRules.minVolumeMultiplier ? 'BULLISH' : 'NEUTRAL' },
      { name: 'Price Displacement', value: `${displacementPercent.toFixed(2)}%`, signal: displacementPercent >= this.config.vwapRules.minSidewaysDisplacementPercent ? 'BULLISH' : 'NEUTRAL' }
    ];

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
      return this.createNoSignalResult(context, ['No definitive VWAP crossover'], indicatorSnapshot, conditionResult, customIndicators);
    }

    // Apply confidence threshold from config using Model C directional arbitration
    // Option A: Evaluate authoritative decision gate on primary timeframe (15m)
    const primaryTfConfidence = confidenceScore.timeframes[timeframeToUse];
    const longScore = primaryTfConfidence
      ? (primaryTfConfidence.longScore ?? primaryTfConfidence.score)
      : confidenceScore.overallLongScore;
    const shortScore = primaryTfConfidence
      ? (primaryTfConfidence.shortScore ?? 0)
      : confidenceScore.overallShortScore;

    const minConfidence = this.config.signalRules.minConfidenceScore;
    if (finalSignalType === SignalType.BUY) {
      if (
        typeof longScore !== 'number' ||
        typeof shortScore !== 'number' ||
        longScore < minConfidence ||
        shortScore >= minConfidence
      ) {
        finalSignalType = null;
        reasoning.push('VWAP: Model C confidence rejected BUY setup');
      } else {
        reasoning.push(`Model C BUY qualified: LongScore (${longScore}) >= ${minConfidence} and ShortScore (${shortScore}) < ${minConfidence}.`);
      }
    } else if (finalSignalType === SignalType.SELL) {
      if (
        typeof longScore !== 'number' ||
        typeof shortScore !== 'number' ||
        shortScore < minConfidence ||
        longScore >= minConfidence
      ) {
        finalSignalType = null;
        reasoning.push('VWAP: Model C confidence rejected SELL setup');
      } else {
        reasoning.push(`Model C SELL qualified: ShortScore (${shortScore}) >= ${minConfidence} and LongScore (${longScore}) < ${minConfidence}.`);
      }
    }

    if (finalSignalType !== null && !this.config.signalRules.allowedRiskClassifications.includes(riskAssessment.riskClassification)) {
      reasoning.push(`VWAP: Risk classification ${riskAssessment.riskClassification} is not allowed by signal rules`);
      finalSignalType = null;
    }

    const hasSignal = finalSignalType !== null && (finalSignalType === SignalType.BUY || finalSignalType === SignalType.SELL);

    let activeSignal: TradingSignal | null = null;
    if (hasSignal && finalSignalType !== null) {
      const directionalScore = finalSignalType === SignalType.SELL
        ? (primaryTfConfidence?.shortScore ?? confidenceScore.overallShortScore!)
        : (primaryTfConfidence?.longScore ?? confidenceScore.overallLongScore!);

      const stopLoss = finalSignalType === SignalType.BUY
        ? currentPrice - riskAssessment.stopLossDistance
        : currentPrice + riskAssessment.stopLossDistance;

      const takeProfit = finalSignalType === SignalType.BUY
        ? currentPrice + riskAssessment.takeProfitDistance
        : currentPrice - riskAssessment.takeProfitDistance;

      activeSignal = {
        symbol: context.marketSnapshot.symbol,
        timeframe: timeframeToUse,
        type: finalSignalType,
        confidenceScore: directionalScore,
        riskAssessment,
        signalPrice: currentPrice,
        targetEntryPrice: null,
        entryPrice: currentPrice,
        stopLoss,
        takeProfit,
        reasoning: [
          `Valid ${finalSignalType} signal generated based on strong conditions.`,
          ...reasoning
        ],
        timestamp: context.timestamp
      };
    }

    // Pinned primary confidenceScore: evaluate on primary timeframe evidence to preserve legacy scalar output
    const directionalConfidence = finalSignalType === SignalType.SELL
      ? (primaryTfConfidence?.shortScore ?? confidenceScore.overallShortScore!)
      : finalSignalType === SignalType.BUY
      ? (primaryTfConfidence?.longScore ?? confidenceScore.overallLongScore!)
      : (primaryTfConfidence?.score ?? confidenceScore.overallScore);

    return {
      strategyId: this.manifest.id,
      timestamp: context.timestamp,
      confidenceScore: directionalConfidence,
      hasSignal,
      metadata: {
        reasoning,
        signal: activeSignal,
        indicatorSnapshot,
        conditionResult,
        confidenceScore,
        strategyConfig: this.config,
        customIndicators
      }
    };
  }

  private createNoSignalResult(
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
        signal: null,
        indicatorSnapshot: indicatorSnapshot || { timestamp: context.timestamp, timeframes: {} },
        conditionResult: conditionResult || { timestamp: context.timestamp, overallPass: false, totalConditions: 0, passedConditions: 0, conditions: [] },
        strategyConfig: this.config,
        customIndicators: customIndicators || []
      }
    };
  }
}
