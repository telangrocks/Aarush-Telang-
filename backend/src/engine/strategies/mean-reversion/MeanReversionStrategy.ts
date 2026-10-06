import { IStrategy } from "../../interfaces/IStrategy";
import { StrategyContext } from "../../context/StrategyContext";
import { EvaluationResult } from "../../dto/EvaluationResult";
import { StrategyManifest } from "../StrategyManifest";
import { IndicatorEngine } from "../../indicator";
import { ConditionEngine } from "../../condition";
import { ConfidenceEngine } from "../../confidence";
import { RiskEngine, RiskContext } from "../../risk";
import { SignalType, TradingSignal } from "../../signal";

import { MEAN_REVERSION_STRATEGY_MANIFEST } from "./MeanReversionRules";
import { MeanReversionConfig, DEFAULT_MEAN_REVERSION_CONFIG } from "./MeanReversionConfig";
import { Timeframe } from "../../market-data/Timeframe";
import { MarketSnapshot, NormalizedCandle } from "../../market-data/MarketSnapshot";
import { CandleValidator } from "../../../infrastructure/exchange/CandleValidator";

/**
 * Derives the candle close timestamp in milliseconds.
 * In Bybit REST / standard exchange models, kline timestamp is open time.
 * If closeTime is not explicitly populated, closeTime = openTime + timeframeMs.
 */
function getCandleCloseTime(candle: NormalizedCandle, tf: Timeframe): number {
  if (typeof (candle as any).closeTime === "number" && (candle as any).closeTime > 0) {
    return (candle as any).closeTime;
  }
  const tfMs = CandleValidator.timeframeToMs(tf);
  if (typeof candle.openTime === "number" && candle.openTime > 0) {
    return candle.openTime + tfMs;
  }
  if (typeof candle.timestamp === "number" && candle.timestamp > 0) {
    return candle.timestamp + tfMs;
  }
  return 0;
}

export class MeanReversionStrategy implements IStrategy {
  public readonly manifest: StrategyManifest = {
    id: MEAN_REVERSION_STRATEGY_MANIFEST.id,
    displayName: MEAN_REVERSION_STRATEGY_MANIFEST.name,
    description: MEAN_REVERSION_STRATEGY_MANIFEST.description,
    version: MEAN_REVERSION_STRATEGY_MANIFEST.version,
    category: MEAN_REVERSION_STRATEGY_MANIFEST.classification,
    riskProfile: MEAN_REVERSION_STRATEGY_MANIFEST.riskProfile,
    supportedMarkets: ["CRYPTO"],
    supportedTimeframes: MEAN_REVERSION_STRATEGY_MANIFEST.supportedTimeframes as Timeframe[],
    minimumCandles: MEAN_REVERSION_STRATEGY_MANIFEST.minimumCandles || 51,
    defaultConfiguration: DEFAULT_MEAN_REVERSION_CONFIG,
    supportsLong: true,
    supportsShort: true,
    supportsPaperTrading: true,
    supportsLiveTrading: true,
    status: "ACTIVE",
    author: MEAN_REVERSION_STRATEGY_MANIFEST.author,
    parameters: [
      { key: "risk_level", displayName: "Risk Level", type: "ENUM", defaultValue: "Medium", isRequired: true, options: ["Low", "Medium", "High"] },
      { key: "mode", displayName: "Mode", type: "ENUM", defaultValue: "Aggressive", isRequired: true, options: ["Conservative", "Moderate", "Aggressive"] }
    ]
  };

  private indicatorEngine: IndicatorEngine;
  private conditionEngine: ConditionEngine;
  private confidenceEngine: ConfidenceEngine;
  private riskEngine: RiskEngine;

  constructor(private config: MeanReversionConfig = DEFAULT_MEAN_REVERSION_CONFIG) {
    this.indicatorEngine = new IndicatorEngine(config.indicatorConfig);
    this.conditionEngine = new ConditionEngine(config.conditionConfig);
    this.confidenceEngine = new ConfidenceEngine(config.confidenceWeights);
    this.riskEngine = new RiskEngine(config.riskParameters);
  }

  public evaluate(context: Readonly<StrategyContext>, targetTimeframe: Timeframe): EvaluationResult {
    const MIN_CLOSED_CANDLES = 51;

    // 0. Fail-Closed Validation: Ensure targetTimeframe is supported by manifest
    if (!this.manifest.supportedTimeframes.includes(targetTimeframe)) {
      return this.createNoSignalResult(context, [`Unsupported timeframe ${targetTimeframe} for ${this.manifest.id}`], targetTimeframe);
    }

    // 1. Snapshot Evaluation Reference Time (T & T_previous)
    const rawCandles = context.marketSnapshot?.candles?.[targetTimeframe];
    if (!rawCandles || rawCandles.length === 0) {
      return this.createNoSignalResult(context, [`[TIMEFRAME DATA] Missing required candle data for timeframe ${targetTimeframe}`], targetTimeframe);
    }

    // Filter forming candles: only closed candles at or before context.timestamp
    const closedCandlesAtRef = rawCandles.filter(c => getCandleCloseTime(c, targetTimeframe) <= context.timestamp);
    if (closedCandlesAtRef.length < MIN_CLOSED_CANDLES) {
      return this.createNoSignalResult(context, [`[TIMEFRAME DATA] Insufficient closed candle data for timeframe ${targetTimeframe} (got ${closedCandlesAtRef.length}, required >= ${MIN_CLOSED_CANDLES})`], targetTimeframe);
    }

    const latestClosed = closedCandlesAtRef[closedCandlesAtRef.length - 1];
    const T = getCandleCloseTime(latestClosed, targetTimeframe);
    const tfMs = CandleValidator.timeframeToMs(targetTimeframe);
    const T_previous = T - tfMs;

    // 2. Build Closed-Candle Projections for T and T_previous strictly on targetTimeframe
    const currentCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {
      [targetTimeframe]: closedCandlesAtRef,
    };
    const closedCandlesAtPrev = rawCandles.filter(c => getCandleCloseTime(c, targetTimeframe) <= T_previous);
    const previousCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {
      [targetTimeframe]: closedCandlesAtPrev,
    };

    // 3. Technical Indicator & Condition Evaluations on Independent Projections
    const snapshotCurrent: MarketSnapshot = {
      ...context.marketSnapshot,
      timestamp: T,
      candles: currentCandlesRecord as any,
    };

    const snapshotPrevious: MarketSnapshot = {
      ...context.marketSnapshot,
      timestamp: T_previous,
      candles: previousCandlesRecord as any,
    };

    // Current technical evaluation
    const currentIndicatorSnapshot = this.indicatorEngine.evaluate(snapshotCurrent);
    const currentConditionResult = this.conditionEngine.evaluate(currentIndicatorSnapshot);
    const currentConfidenceScore = this.confidenceEngine.evaluate(currentConditionResult);

    // Previous technical evaluation
    let previousIndicatorSnapshot: any = null;
    const hasValidPreviousData = Boolean(previousCandlesRecord[targetTimeframe] && previousCandlesRecord[targetTimeframe]!.length >= 50);

    if (hasValidPreviousData) {
      previousIndicatorSnapshot = this.indicatorEngine.evaluate(snapshotPrevious);
    }

    // 4. Pure Market Alignment Helper (Authoritative on targetTimeframe Entry Trigger)
    const tfUpper = targetTimeframe.toUpperCase();
    const evaluateMarketAlignment = (
      indSnapshot: any
    ): {
      isAlignedBuy: boolean;
      isAlignedSell: boolean;
      tfReasoning: string[];
      separation: number;
      hasBuyCurl: boolean;
      hasSellCurl: boolean;
    } => {
      const tfReasoning: string[] = [];
      let sepTf = 0;

      const tfInd = indSnapshot?.timeframes?.[targetTimeframe];
      const ema20Arr = tfInd?.ema?.[this.config.conditionConfig.emaFastPeriod]; // 20
      const ema50Arr = tfInd?.ema?.[this.config.conditionConfig.emaSlowPeriod]; // 50

      if (ema20Arr && ema50Arr && ema20Arr.length > 0 && ema50Arr.length > 0) {
        const currentEma20 = ema20Arr[ema20Arr.length - 1];
        const currentEma50 = ema50Arr[ema50Arr.length - 1];

        if (
          typeof currentEma20 === "number" && !isNaN(currentEma20) &&
          typeof currentEma50 === "number" && !isNaN(currentEma50) && currentEma50 > 0
        ) {
          sepTf = Math.abs(currentEma20 - currentEma50) / currentEma50 * 100;
          if (sepTf <= this.config.trendFilter.maxEmaSeparationPercent) {
            tfReasoning.push(`[${tfUpper} INFO] EMA separation (${sepTf.toFixed(2)}%) <= ${this.config.trendFilter.maxEmaSeparationPercent}%.`);
          } else {
            tfReasoning.push(`[${tfUpper} INFO] EMA separation (${sepTf.toFixed(2)}%) > ${this.config.trendFilter.maxEmaSeparationPercent}%. Strong trend detected.`);
          }
        }
      }

      // Precision Reversal Trigger on targetTimeframe: 2-step RSI14 reversal
      const rsiArr = tfInd?.rsi?.[this.config.conditionConfig.rsiPeriod]; // 14

      if (!rsiArr || rsiArr.length < 2) {
        tfReasoning.push(`[TIMEFRAME FAIL-CLOSED] ${targetTimeframe} entry trigger missing required RSI values.`);
        return { isAlignedBuy: false, isAlignedSell: false, tfReasoning, separation: sepTf, hasBuyCurl: false, hasSellCurl: false };
      }

      const previousRsi = rsiArr[rsiArr.length - 2];
      const currentRsi = rsiArr[rsiArr.length - 1];

      if (
        typeof previousRsi !== "number" || isNaN(previousRsi) ||
        typeof currentRsi !== "number" || isNaN(currentRsi)
      ) {
        tfReasoning.push(`[TIMEFRAME FAIL-CLOSED] ${targetTimeframe} RSI contains invalid or NaN values.`);
        return { isAlignedBuy: false, isAlignedSell: false, tfReasoning, separation: sepTf, hasBuyCurl: false, hasSellCurl: false };
      }

      let hasBuyCurl = false;
      let hasSellCurl = false;

      if (this.config.entryRules.requireTwoStepConfirmation) {
        const wasOversold = previousRsi <= this.config.conditionConfig.rsiOversold; // <= 25
        const wasOverbought = previousRsi >= this.config.conditionConfig.rsiOverbought; // >= 75

        hasBuyCurl = wasOversold && currentRsi > previousRsi;
        hasSellCurl = wasOverbought && currentRsi < previousRsi;
      } else {
        hasBuyCurl = currentRsi <= this.config.conditionConfig.rsiOversold;
        hasSellCurl = currentRsi >= this.config.conditionConfig.rsiOverbought;
      }

      if (hasBuyCurl) {
        tfReasoning.push(`[${tfUpper} TRIGGER] Valid ${targetTimeframe} oversold curl detected (prev RSI: ${previousRsi.toFixed(2)} <= ${this.config.conditionConfig.rsiOversold}, curr RSI: ${currentRsi.toFixed(2)} > ${previousRsi.toFixed(2)}).`);
      }
      if (hasSellCurl) {
        tfReasoning.push(`[${tfUpper} TRIGGER] Valid ${targetTimeframe} overbought curl detected (prev RSI: ${previousRsi.toFixed(2)} >= ${this.config.conditionConfig.rsiOverbought}, curr RSI: ${currentRsi.toFixed(2)} < ${previousRsi.toFixed(2)}).`);
      }
      if (!hasBuyCurl && !hasSellCurl) {
        tfReasoning.push(`[${tfUpper} TRIGGER] No valid ${targetTimeframe} RSI reversal curl (prev RSI: ${previousRsi.toFixed(2)}, curr RSI: ${currentRsi.toFixed(2)}).`);
      }

      const isAlignedBuy = hasBuyCurl;
      const isAlignedSell = hasSellCurl;

      return {
        isAlignedBuy,
        isAlignedSell,
        tfReasoning,
        separation: sepTf,
        hasBuyCurl,
        hasSellCurl
      };
    };

    // Evaluate market alignment at T and T_previous
    const currentAlignment = evaluateMarketAlignment(currentIndicatorSnapshot);

    let previousAlignment = { isAlignedBuy: false, isAlignedSell: false };
    if (hasValidPreviousData && previousIndicatorSnapshot) {
      previousAlignment = evaluateMarketAlignment(previousIndicatorSnapshot);
    }

    // Edge transition: emit only when transitioning from NOT ALIGNED to ALIGNED
    const isNewBuyEvent = currentAlignment.isAlignedBuy && !previousAlignment.isAlignedBuy;
    const isNewSellEvent = currentAlignment.isAlignedSell && !previousAlignment.isAlignedSell;

    const reasoning: string[] = [...currentAlignment.tfReasoning];

    let targetSignalType: SignalType | null = null;
    if (isNewBuyEvent) {
      targetSignalType = SignalType.BUY;
      reasoning.push(`Mean Reversion: Buy setup confirmed via oversold bounce on ${targetTimeframe}`);
      reasoning.push(`[${tfUpper} EDGE EVENT] New BUY event: ${targetTimeframe} trigger transitioned from NOT ALIGNED to ALIGNED.`);
    } else if (isNewSellEvent) {
      if (this.manifest.supportsShort) {
        targetSignalType = SignalType.SELL;
        reasoning.push(`Mean Reversion: Sell setup confirmed via overbought rejection on ${targetTimeframe}`);
        reasoning.push(`[${tfUpper} EDGE EVENT] New SELL event: ${targetTimeframe} trigger transitioned from NOT ALIGNED to ALIGNED.`);
      } else {
        reasoning.push("Mean Reversion: Sell setup detected but shorting is disabled");
      }
    } else {
      if (currentAlignment.isAlignedBuy && previousAlignment.isAlignedBuy) {
        reasoning.push(`[${tfUpper} CONTINUATION] Trend continuation suppressed: ${targetTimeframe} BUY trigger already active on previous bar.`);
      } else if (currentAlignment.isAlignedSell && previousAlignment.isAlignedSell) {
        reasoning.push(`[${tfUpper} CONTINUATION] Trend continuation suppressed: ${targetTimeframe} SELL trigger already active on previous bar.`);
      } else if (!currentAlignment.isAlignedBuy && !currentAlignment.isAlignedSell) {
        reasoning.push(`No qualified signal generated on ${targetTimeframe} trigger.`);
      }
    }

    // Telemetry confidence score strictly for targetTimeframe
    const primaryTfConfidence = currentConfidenceScore.timeframes[targetTimeframe];
    const longScore = primaryTfConfidence
      ? (primaryTfConfidence.longScore ?? primaryTfConfidence.score)
      : 0;
    const shortScore = primaryTfConfidence
      ? (primaryTfConfidence.shortScore ?? 0)
      : 0;

    if (targetSignalType === SignalType.BUY) {
      reasoning.push(`Mean Reversion BUY setup active: LongScore (${longScore}), ShortScore (${shortScore}).`);
    } else if (targetSignalType === SignalType.SELL) {
      reasoning.push(`Mean Reversion SELL setup active: ShortScore (${shortScore}), LongScore (${longScore}).`);
    }

    const customIndicators = [
      {
        name: `EMA Separation (${targetTimeframe})`,
        value: `${currentAlignment.separation.toFixed(2)}%`,
        signal: currentAlignment.separation <= this.config.trendFilter.maxEmaSeparationPercent ? "BULLISH" : "BEARISH"
      },
      {
        name: `2-Step Reversal (${targetTimeframe})`,
        value: currentAlignment.hasBuyCurl ? "Oversold Bounce" : currentAlignment.hasSellCurl ? "Overbought Rejection" : "Neutral",
        signal: currentAlignment.hasBuyCurl ? "BULLISH" : currentAlignment.hasSellCurl ? "BEARISH" : "NEUTRAL"
      }
    ];

    if (!targetSignalType) {
      const directionalConfidence = (primaryTfConfidence?.score ?? 0);
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: directionalConfidence,
        hasSignal: false,
        metadata: {
          reasoning,
          signal: null,
          indicatorSnapshot: currentIndicatorSnapshot,
          conditionResult: currentConditionResult,
          confidenceScore: currentConfidenceScore,
          strategyConfig: this.config,
          customIndicators,
          targetTimeframe,
        }
      };
    }

    // 5. Risk validation downstream of edge transition
    const entryCandles = currentCandlesRecord[targetTimeframe]!;
    const latestCandleClose = entryCandles[entryCandles.length - 1]?.close || 0;
    const currentPrice = latestCandleClose > 0 ? latestCandleClose : context.marketSnapshot.currentPrice || 0;

    if (currentPrice <= 0) {
      return this.createNoSignalResult(context, ["Invalid current price (zero or negative)"], targetTimeframe, currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
    }

    if (!context.accountBalance || context.accountBalance <= 0) {
      return this.createNoSignalResult(context, ["Account balance is zero or unconfigured"], targetTimeframe, currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
    }

    // ATR risk calculation strictly on targetTimeframe ATR
    const tfIndicators = currentIndicatorSnapshot.timeframes[targetTimeframe];
    const atrArray = tfIndicators?.atr?.[this.config.conditionConfig.atrPeriod]; // 14
    let currentAtr = (atrArray && atrArray.length > 0) ? atrArray[atrArray.length - 1] : 0;

    if (!currentAtr || currentAtr <= 0 || isNaN(currentAtr)) {
      return this.createNoSignalResult(context, ["ATR is zero or unavailable — cannot calculate risk parameters"], targetTimeframe, currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
    }

    const riskContext: RiskContext = {
      timestamp: T,
      currentPrice,
      currentAtr,
      accountBalance: context.accountBalance
    };
    const riskAssessment = this.riskEngine.evaluate(riskContext);

    // Risk classification gate: LOW / MEDIUM only
    if (!this.config.signalRules.allowedRiskClassifications.includes(riskAssessment.riskClassification)) {
      reasoning.push(`Mean Reversion: Risk classification ${riskAssessment.riskClassification} is not allowed by signal rules`);
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning,
          signal: null,
          indicatorSnapshot: currentIndicatorSnapshot,
          conditionResult: currentConditionResult,
          confidenceScore: currentConfidenceScore,
          strategyConfig: this.config,
          customIndicators,
          targetTimeframe,
        }
      };
    }

    // 6. Construct TradingSignal
    const directionalScore = targetSignalType === SignalType.SELL
      ? (primaryTfConfidence?.shortScore ?? 0)
      : (primaryTfConfidence?.longScore ?? 0);

    const stopLoss = targetSignalType === SignalType.BUY
      ? currentPrice - riskAssessment.stopLossDistance
      : currentPrice + riskAssessment.stopLossDistance;

    const takeProfit = targetSignalType === SignalType.BUY
      ? currentPrice + riskAssessment.takeProfitDistance
      : currentPrice - riskAssessment.takeProfitDistance;

    const activeSignal: TradingSignal = {
      symbol: context.marketSnapshot.symbol,
      timeframe: targetTimeframe,
      type: targetSignalType,
      confidenceScore: directionalScore,
      riskAssessment,
      signalPrice: currentPrice,
      targetEntryPrice: null,
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      reasoning: [
        `Valid ${targetSignalType} signal generated based on strong conditions.`,
        ...reasoning
      ],
      timestamp: context.timestamp
    };

    return {
      strategyId: this.manifest.id,
      timestamp: context.timestamp,
      confidenceScore: directionalScore,
      hasSignal: true,
      metadata: {
        reasoning,
        signal: activeSignal,
        indicatorSnapshot: currentIndicatorSnapshot,
        conditionResult: currentConditionResult,
        confidenceScore: currentConfidenceScore,
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
    confidenceScore?: any,
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
