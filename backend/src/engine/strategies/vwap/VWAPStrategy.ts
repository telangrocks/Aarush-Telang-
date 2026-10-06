import { IStrategy } from '../../interfaces/IStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { EvaluationResult } from '../../dto/EvaluationResult';
import { StrategyManifest } from '../StrategyManifest';
import { IndicatorEngine } from '../../indicator';
import { ConditionEngine } from '../../condition';
import { ConfidenceEngine, ConfidenceScore } from '../../confidence';
import { RiskEngine, RiskContext } from '../../risk';
import { SignalType, TradingSignal } from '../../signal';
import { Timeframe } from '../../market-data/Timeframe';
import { MarketSnapshot, NormalizedCandle } from '../../market-data/MarketSnapshot';
import { CandleValidator } from '../../../infrastructure/exchange/CandleValidator';

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

  public evaluate(context: Readonly<StrategyContext>, targetTimeframe: Timeframe): EvaluationResult {
    // 0. Fail-Closed Validation: Ensure targetTimeframe is supported by manifest (e.g. 15m, 1h, 4h; fail 5m)
    if (!this.manifest.supportedTimeframes.includes(targetTimeframe)) {
      return this.createNoSignalResult(context, [`Unsupported timeframe ${targetTimeframe} for ${this.manifest.id}`], targetTimeframe);
    }

    const rawCandles = context.marketSnapshot.candles?.[targetTimeframe];
    if (!rawCandles || rawCandles.length === 0) {
      return this.createNoSignalResult(context, [`[TIMEFRAME DATA] Missing required candle data for timeframe ${targetTimeframe}`], targetTimeframe);
    }

    const getCandleCloseTime = (c: NormalizedCandle, tf: string): number => {
      return (c as any).closeTime ?? ((c.openTime ?? c.timestamp ?? 0) + CandleValidator.timeframeToMs(tf));
    };

    const closedCandles = rawCandles.filter(c => getCandleCloseTime(c, targetTimeframe) <= context.timestamp);
    if (closedCandles.length < 2) {
      return this.createNoSignalResult(context, [`Insufficient closed candle data for analysis (minimum 2 closed candles required for timeframe ${targetTimeframe})`], targetTimeframe);
    }

    // Build Closed-Candle Projections for targetTimeframe
    const currentCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {
      [targetTimeframe]: closedCandles,
    };

    const snapshotCurrent: MarketSnapshot = {
      ...context.marketSnapshot,
      timestamp: context.timestamp,
      candles: currentCandlesRecord as any,
    };

    // 1. Indicators
    const indicatorSnapshot = this.indicatorEngine.evaluate(snapshotCurrent);

    // 2. Conditions
    const conditionResult = this.conditionEngine.evaluate(indicatorSnapshot);

    // 3. Confidence
    const confidenceScore = this.confidenceEngine.evaluate(conditionResult);

    const currentCandle = closedCandles[closedCandles.length - 1];
    const previousCandle = closedCandles[closedCandles.length - 2];

    // Guard A — Current price validation
    const currentPrice = currentCandle?.close || context.marketSnapshot.currentPrice || 0;
    const previousPrice = previousCandle?.close || currentPrice;

    if (!currentPrice || currentPrice <= 0) {
      return this.createNoSignalResult(context, ['Invalid or missing current price'], targetTimeframe, indicatorSnapshot, conditionResult);
    }

    // Guard B — Account balance validation
    if (!context.accountBalance || context.accountBalance <= 0) {
      return this.createNoSignalResult(context, ['Account balance is zero or unconfigured'], targetTimeframe, indicatorSnapshot, conditionResult);
    }

    // Retrieve standard indicators needed for evaluation strictly on targetTimeframe
    const tfIndicators = indicatorSnapshot.timeframes[targetTimeframe];
    if (!tfIndicators) {
      return this.createNoSignalResult(context, [`Indicators failed to calculate for ${targetTimeframe}`], targetTimeframe, indicatorSnapshot, conditionResult);
    }

    // -- Strategy Specific Logic: VWAP Calculation & Validation --
    const vwapValues = VWAPCalculator.calculate(closedCandles);
    const currentVwap = vwapValues[vwapValues.length - 1];
    const previousVwap = vwapValues[vwapValues.length - 2];

    // Distance from VWAP Check (Over-extension)
    const deviationPercent = Math.abs(currentPrice - currentVwap) / currentVwap * 100;
    if (deviationPercent > this.config.vwapRules.maxDeviationThresholdPercent) {
      return this.createNoSignalResult(context, ['Price excessively extended away from VWAP'], targetTimeframe, indicatorSnapshot, conditionResult, confidenceScore);
    }

    // Sideways Chop Check (Minimum Displacement)
    const displacementPercent = Math.abs(currentPrice - previousPrice) / previousPrice * 100;
    if (displacementPercent < this.config.vwapRules.minSidewaysDisplacementPercent) {
      return this.createNoSignalResult(context, ['No meaningful VWAP displacement (sideways market)'], targetTimeframe, indicatorSnapshot, conditionResult, confidenceScore);
    }

    // Volume Confirmation Check
    let avgVolume = 0;
    if (tfIndicators.volume && tfIndicators.volume.length > 0 && !isNaN(tfIndicators.volume[tfIndicators.volume.length - 1].averageVolume)) {
      avgVolume = tfIndicators.volume[tfIndicators.volume.length - 1].averageVolume;
    } else {
      avgVolume = closedCandles.reduce((sum: number, c: NormalizedCandle) => sum + (c.volume || 0), 0) / closedCandles.length;
    }

    if (currentCandle.volume < avgVolume * this.config.vwapRules.minVolumeMultiplier) {
      return this.createNoSignalResult(context, ['Low volume rejection (volume confirmation not met)'], targetTimeframe, indicatorSnapshot, conditionResult, confidenceScore);
    }

    // Identify interactions with VWAP (Crossovers)
    const crossedAboveVwap = previousPrice <= previousVwap && currentPrice > currentVwap;
    const crossedBelowVwap = previousPrice >= previousVwap && currentPrice < currentVwap;

    // 4. Risk strictly on targetTimeframe ATR
    const atrArray = tfIndicators.atr?.[this.config.conditionConfig.atrPeriod];
    const currentAtr = (atrArray && atrArray.length > 0) ? atrArray[atrArray.length - 1] : 0;

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
      reasoning.push(`VWAP: Strong volume crossover above fair value on ${targetTimeframe}`);
    } else if (crossedBelowVwap) {
      if (this.manifest.supportsShort) {
        finalSignalType = SignalType.SELL;
        reasoning.push(`VWAP: Strong volume crossover below fair value on ${targetTimeframe}`);
      } else {
        reasoning.push('VWAP: Bearish setup detected but shorting is disabled');
      }
    } else {
      return this.createNoSignalResult(context, ['No definitive VWAP crossover'], targetTimeframe, indicatorSnapshot, conditionResult, confidenceScore, customIndicators);
    }

    // Apply confidence threshold from config using Model C directional arbitration on targetTimeframe
    const primaryTfConfidence = confidenceScore.timeframes?.[targetTimeframe];
    const longScore = primaryTfConfidence
      ? (primaryTfConfidence.longScore ?? primaryTfConfidence.score)
      : (confidenceScore.overallLongScore ?? 0);
    const shortScore = primaryTfConfidence
      ? (primaryTfConfidence.shortScore ?? 0)
      : (confidenceScore.overallShortScore ?? 0);

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
        ? (primaryTfConfidence?.shortScore ?? confidenceScore.overallShortScore ?? 0)
        : (primaryTfConfidence?.longScore ?? confidenceScore.overallLongScore ?? 0);

      const stopLoss = finalSignalType === SignalType.BUY
        ? currentPrice - riskAssessment.stopLossDistance
        : currentPrice + riskAssessment.stopLossDistance;

      const takeProfit = finalSignalType === SignalType.BUY
        ? currentPrice + riskAssessment.takeProfitDistance
        : currentPrice - riskAssessment.takeProfitDistance;

      activeSignal = {
        symbol: context.marketSnapshot.symbol,
        timeframe: targetTimeframe,
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

    const directionalConfidence = finalSignalType === SignalType.SELL
      ? (primaryTfConfidence?.shortScore ?? confidenceScore.overallShortScore ?? 0)
      : finalSignalType === SignalType.BUY
      ? (primaryTfConfidence?.longScore ?? confidenceScore.overallLongScore ?? 0)
      : (primaryTfConfidence?.score ?? confidenceScore.overallScore ?? 0);

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
        customIndicators,
        targetTimeframe,
      }
    };
  }

  private createNoSignalResult(
    context: Readonly<StrategyContext>,
    reasoning: string[],
    targetTimeframe?: Timeframe,
    indicatorSnapshot?: any,
    conditionResult?: any,
    confidenceScore?: ConfidenceScore,
    customIndicators?: any[]
  ): EvaluationResult {
    const tfConf = targetTimeframe && confidenceScore?.timeframes ? confidenceScore.timeframes[targetTimeframe] : undefined;
    const resolvedScore = tfConf?.score ?? confidenceScore?.overallScore ?? 0;

    return {
      strategyId: this.manifest.id,
      timestamp: context.timestamp,
      confidenceScore: resolvedScore,
      hasSignal: false,
      metadata: {
        reasoning,
        signal: null,
        targetTimeframe,
        indicatorSnapshot: indicatorSnapshot || { timestamp: context.timestamp, timeframes: {} },
        conditionResult: conditionResult || { timestamp: context.timestamp, overallPass: false, totalConditions: 0, passedConditions: 0, conditions: [] },
        confidenceScore: confidenceScore || null,
        strategyConfig: this.config,
        customIndicators: customIndicators || []
      }
    };
  }
}
