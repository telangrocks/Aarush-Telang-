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

  public evaluate(context: Readonly<StrategyContext>): EvaluationResult {
    // Four-Timeframe Confluence Architecture:
    // 4h  → Structural Anti-Runaway Gate (EMA separation <= 5.0%)
    // 1h  → Macro Anti-Runaway Gate (EMA separation <= 5.0%)
    // 15m → Intermediate Setup & Risk Anchor (EMA separation <= 5.0%, ATR14)
    // 5m  → Precision Mean-Reversion Entry Trigger (RSI 2-step reversal)
    const ENTRY_TIMEFRAME = "5m" as const;
    const RISK_TIMEFRAME = "15m" as const;
    const ALL_REQUIRED_TIMEFRAMES = ["5m", "15m", "1h", "4h"] as const;
    const MIN_CLOSED_CANDLES = 51;

    // 1. Snapshot Evaluation Reference Time (T & T_previous)
    const raw5mCandles = context.marketSnapshot?.candles?.[ENTRY_TIMEFRAME];
    if (!raw5mCandles || raw5mCandles.length === 0) {
      return this.createNoSignalResult(context, [`[MTF DATA] Missing required candle data for timeframe ${ENTRY_TIMEFRAME}`]);
    }

    // Filter forming 5m candles: only closed candles at or before context.timestamp
    const closed5mAtRef = raw5mCandles.filter(c => getCandleCloseTime(c, ENTRY_TIMEFRAME) <= context.timestamp);
    if (closed5mAtRef.length < MIN_CLOSED_CANDLES) {
      return this.createNoSignalResult(context, [`[MTF DATA] Insufficient closed candle data for timeframe ${ENTRY_TIMEFRAME} (got ${closed5mAtRef.length}, required >= ${MIN_CLOSED_CANDLES})`]);
    }

    const latestClosed5m = closed5mAtRef[closed5mAtRef.length - 1];
    const T = getCandleCloseTime(latestClosed5m, ENTRY_TIMEFRAME);
    const fiveMinMs = CandleValidator.timeframeToMs(ENTRY_TIMEFRAME);
    const T_previous = T - fiveMinMs;

    // 2. Build Closed-Candle Projections for T and T_previous across all 4 required timeframes
    const currentCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {};
    const previousCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {};

    for (const tf of ALL_REQUIRED_TIMEFRAMES) {
      const rawTfCandles = context.marketSnapshot?.candles?.[tf];
      if (!rawTfCandles || rawTfCandles.length === 0) {
        return this.createNoSignalResult(context, [`[MTF DATA] Missing required candle data for timeframe ${tf}`]);
      }

      // Filter closed candles at or before T (forming candles strictly excluded)
      const closedAtT = rawTfCandles.filter(c => getCandleCloseTime(c, tf) <= T);
      if (closedAtT.length < MIN_CLOSED_CANDLES) {
        return this.createNoSignalResult(context, [`[MTF DATA] Insufficient closed candle data for timeframe ${tf} (got ${closedAtT.length}, required >= ${MIN_CLOSED_CANDLES})`]);
      }
      currentCandlesRecord[tf] = closedAtT;

      // Filter closed candles at or before T_previous
      const closedAtTPrev = rawTfCandles.filter(c => getCandleCloseTime(c, tf) <= T_previous);
      previousCandlesRecord[tf] = closedAtTPrev;
    }

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
    let hasValidPreviousData = true;

    for (const tf of ALL_REQUIRED_TIMEFRAMES) {
      if (!previousCandlesRecord[tf] || previousCandlesRecord[tf]!.length < 50) {
        hasValidPreviousData = false;
        break;
      }
    }

    if (hasValidPreviousData) {
      previousIndicatorSnapshot = this.indicatorEngine.evaluate(snapshotPrevious);
    }

    // 4. Pure Market Alignment Helper
    const evaluateMarketAlignment = (
      indSnapshot: any
    ): {
      isAlignedBuy: boolean;
      isAlignedSell: boolean;
      tfReasoning: string[];
      separation15m: number;
      hasBuyCurl: boolean;
      hasSellCurl: boolean;
    } => {
      const tfReasoning: string[] = [];
      let isStabilityPassing = true;
      let sep15m = 0;

      // Anti-Runaway Structural Gates: 4H, 1H, 15M EMA20/EMA50 separation <= 5.0%
      const STABILITY_TIMEFRAMES = ["4h", "1h", "15m"] as const;
      const TF_ROLES: Record<string, string> = {
        "4h": "Structural Bias",
        "1h": "Macro Trend",
        "15m": "Intermediate Setup & Risk Anchor",
        "5m": "Precision Reversal Trigger"
      };

      for (const tf of STABILITY_TIMEFRAMES) {
        const tfInd = indSnapshot?.timeframes?.[tf];
        const ema20Arr = tfInd?.ema?.[this.config.conditionConfig.emaFastPeriod]; // 20
        const ema50Arr = tfInd?.ema?.[this.config.conditionConfig.emaSlowPeriod]; // 50

        if (!ema20Arr || !ema50Arr || ema20Arr.length === 0 || ema50Arr.length === 0) {
          isStabilityPassing = false;
          tfReasoning.push(`[MTF FAIL-CLOSED] ${TF_ROLES[tf]} (${tf}) missing required EMA indicators.`);
          continue;
        }

        const currentEma20 = ema20Arr[ema20Arr.length - 1];
        const currentEma50 = ema50Arr[ema50Arr.length - 1];

        if (
          typeof currentEma20 !== "number" || isNaN(currentEma20) ||
          typeof currentEma50 !== "number" || isNaN(currentEma50) || currentEma50 <= 0
        ) {
          isStabilityPassing = false;
          tfReasoning.push(`[MTF FAIL-CLOSED] ${TF_ROLES[tf]} (${tf}) invalid EMA values.`);
          continue;
        }

        const emaSeparation = Math.abs(currentEma20 - currentEma50) / currentEma50 * 100;
        if (tf === "15m") {
          sep15m = emaSeparation;
        }

        if (emaSeparation <= this.config.trendFilter.maxEmaSeparationPercent) {
          tfReasoning.push(`[MTF STABLE] ${TF_ROLES[tf]} (${tf}) EMA separation (${emaSeparation.toFixed(2)}%) <= ${this.config.trendFilter.maxEmaSeparationPercent}%.`);
        } else {
          isStabilityPassing = false;
          tfReasoning.push(`[MTF RUNAWAY] ${TF_ROLES[tf]} (${tf}) EMA separation (${emaSeparation.toFixed(2)}%) > ${this.config.trendFilter.maxEmaSeparationPercent}%. Strong trend detected.`);
        }
      }

      // 5M Precision Reversal Trigger: 2-step RSI14 reversal
      const tf5mInd = indSnapshot?.timeframes?.[ENTRY_TIMEFRAME];
      const rsiArr = tf5mInd?.rsi?.[this.config.conditionConfig.rsiPeriod]; // 14

      if (!rsiArr || rsiArr.length < 2) {
        tfReasoning.push(`[MTF FAIL-CLOSED] 5m entry trigger missing required RSI values.`);
        return { isAlignedBuy: false, isAlignedSell: false, tfReasoning, separation15m: sep15m, hasBuyCurl: false, hasSellCurl: false };
      }

      const previousRsi = rsiArr[rsiArr.length - 2];
      const currentRsi = rsiArr[rsiArr.length - 1];

      if (
        typeof previousRsi !== "number" || isNaN(previousRsi) ||
        typeof currentRsi !== "number" || isNaN(currentRsi)
      ) {
        tfReasoning.push(`[MTF FAIL-CLOSED] 5m RSI contains invalid or NaN values.`);
        return { isAlignedBuy: false, isAlignedSell: false, tfReasoning, separation15m: sep15m, hasBuyCurl: false, hasSellCurl: false };
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
        tfReasoning.push(`[MTF 5M TRIGGER] Valid 5m oversold curl detected (prev RSI: ${previousRsi.toFixed(2)} <= ${this.config.conditionConfig.rsiOversold}, curr RSI: ${currentRsi.toFixed(2)} > ${previousRsi.toFixed(2)}).`);
      }
      if (hasSellCurl) {
        tfReasoning.push(`[MTF 5M TRIGGER] Valid 5m overbought curl detected (prev RSI: ${previousRsi.toFixed(2)} >= ${this.config.conditionConfig.rsiOverbought}, curr RSI: ${currentRsi.toFixed(2)} < ${previousRsi.toFixed(2)}).`);
      }
      if (!hasBuyCurl && !hasSellCurl) {
        tfReasoning.push(`[MTF 5M TRIGGER] No valid 5m RSI reversal curl (prev RSI: ${previousRsi.toFixed(2)}, curr RSI: ${currentRsi.toFixed(2)}).`);
      }

      const isAlignedBuy = isStabilityPassing && hasBuyCurl;
      const isAlignedSell = isStabilityPassing && hasSellCurl;

      return {
        isAlignedBuy,
        isAlignedSell,
        tfReasoning,
        separation15m: sep15m,
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
      reasoning.push("Mean Reversion: Buy setup confirmed via oversold bounce");
      reasoning.push("[MTF EDGE EVENT] New BUY event: 4TF confluence transitioned from NOT ALIGNED to ALIGNED.");
    } else if (isNewSellEvent) {
      if (this.manifest.supportsShort) {
        targetSignalType = SignalType.SELL;
        reasoning.push("Mean Reversion: Sell setup confirmed via overbought rejection");
        reasoning.push("[MTF EDGE EVENT] New SELL event: 4TF confluence transitioned from NOT ALIGNED to ALIGNED.");
      } else {
        reasoning.push("Mean Reversion: Sell setup detected but shorting is disabled");
      }
    } else {
      if (currentAlignment.isAlignedBuy && previousAlignment.isAlignedBuy) {
        reasoning.push("[MTF CONTINUATION] Trend continuation suppressed: 4TF BUY confluence already active on previous bar.");
      } else if (currentAlignment.isAlignedSell && previousAlignment.isAlignedSell) {
        reasoning.push("[MTF CONTINUATION] Trend continuation suppressed: 4TF SELL confluence already active on previous bar.");
      } else if (!currentAlignment.isAlignedBuy && !currentAlignment.isAlignedSell) {
        reasoning.push("[MTF REJECTED] Trade cancelled: Multi-timeframe confluence failed across 4h, 1h, 15m, and 5m.");
      }
    }

    // Telemetry confidence score
    const primaryTfConfidence = currentConfidenceScore.timeframes[ENTRY_TIMEFRAME];
    const longScore = primaryTfConfidence
      ? (primaryTfConfidence.longScore ?? primaryTfConfidence.score)
      : (currentConfidenceScore.overallLongScore ?? currentConfidenceScore.overallScore);
    const shortScore = primaryTfConfidence
      ? (primaryTfConfidence.shortScore ?? 0)
      : (currentConfidenceScore.overallShortScore ?? 0);

    if (targetSignalType === SignalType.BUY) {
      reasoning.push(`Mean Reversion BUY setup active: LongScore (${longScore}), ShortScore (${shortScore}).`);
    } else if (targetSignalType === SignalType.SELL) {
      reasoning.push(`Mean Reversion SELL setup active: ShortScore (${shortScore}), LongScore (${longScore}).`);
    }

    const customIndicators = [
      {
        name: "EMA Separation (15m)",
        value: `${currentAlignment.separation15m.toFixed(2)}%`,
        signal: currentAlignment.separation15m <= this.config.trendFilter.maxEmaSeparationPercent ? "BULLISH" : "BEARISH"
      },
      {
        name: "2-Step Reversal (5m)",
        value: currentAlignment.hasBuyCurl ? "Oversold Bounce" : currentAlignment.hasSellCurl ? "Overbought Rejection" : "Neutral",
        signal: currentAlignment.hasBuyCurl ? "BULLISH" : currentAlignment.hasSellCurl ? "BEARISH" : "NEUTRAL"
      }
    ];

    if (!targetSignalType) {
      const directionalConfidence = (primaryTfConfidence?.score ?? currentConfidenceScore.overallScore);
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
          customIndicators
        }
      };
    }

    // 5. Risk validation downstream of edge transition
    const entryCandles = currentCandlesRecord[ENTRY_TIMEFRAME]!;
    const latestCandleClose = entryCandles[entryCandles.length - 1]?.close || 0;
    const currentPrice = latestCandleClose > 0 ? latestCandleClose : context.marketSnapshot.currentPrice || 0;

    if (currentPrice <= 0) {
      return this.createNoSignalResult(context, ["Invalid current price (zero or negative)"], currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
    }

    if (!context.accountBalance || context.accountBalance <= 0) {
      return this.createNoSignalResult(context, ["Account balance is zero or unconfigured"], currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
    }

    // 15m ATR risk anchor strictly preserved for Mean Reversion
    const tfIndicators15m = currentIndicatorSnapshot.timeframes[RISK_TIMEFRAME];
    const atrArray15m = tfIndicators15m?.atr?.[this.config.conditionConfig.atrPeriod]; // 14
    const currentAtr = (atrArray15m && atrArray15m.length > 0) ? atrArray15m[atrArray15m.length - 1] : 0;

    if (!currentAtr || currentAtr <= 0 || isNaN(currentAtr)) {
      return this.createNoSignalResult(context, ["ATR is zero or unavailable — cannot calculate risk parameters"], currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
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
          customIndicators
        }
      };
    }

    // 6. Construct TradingSignal
    const directionalScore = targetSignalType === SignalType.SELL
      ? (primaryTfConfidence?.shortScore ?? currentConfidenceScore.overallShortScore ?? 0)
      : (primaryTfConfidence?.longScore ?? currentConfidenceScore.overallLongScore ?? 0);

    const stopLoss = targetSignalType === SignalType.BUY
      ? currentPrice - riskAssessment.stopLossDistance
      : currentPrice + riskAssessment.stopLossDistance;

    const takeProfit = targetSignalType === SignalType.BUY
      ? currentPrice + riskAssessment.takeProfitDistance
      : currentPrice - riskAssessment.takeProfitDistance;

    const activeSignal: TradingSignal = {
      symbol: context.marketSnapshot.symbol,
      timeframe: ENTRY_TIMEFRAME,
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
        customIndicators
      }
    };
  }

  private createNoSignalResult(
    context: Readonly<StrategyContext>,
    reasoning: string[],
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
        indicatorSnapshot: indicatorSnapshot || { timestamp: context.timestamp, timeframes: {} },
        conditionResult: conditionResult || { timestamp: context.timestamp, overallPass: false, totalConditions: 0, passedConditions: 0, conditions: [] },
        confidenceScore: confidenceScore || null,
        strategyConfig: this.config,
        customIndicators: customIndicators || []
      }
    };
  }
}
