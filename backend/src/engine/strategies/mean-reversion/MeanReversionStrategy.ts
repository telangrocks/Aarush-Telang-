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
  private rejectedEdgeEvents = new Map<string, {
    timestamp: number;
    direction: SignalType;
    reason: 'ACCOUNT_BALANCE_UNAVAILABLE' | 'DISALLOWED_RISK_CLASSIFICATION';
  }>();

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
      previousRsi: number;
      currentRsi: number;
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
        return { isAlignedBuy: false, isAlignedSell: false, tfReasoning, separation: sepTf, hasBuyCurl: false, hasSellCurl: false, previousRsi: 0, currentRsi: 0 };
      }

      const previousRsi = rsiArr[rsiArr.length - 2];
      const currentRsi = rsiArr[rsiArr.length - 1];

      if (
        typeof previousRsi !== "number" || isNaN(previousRsi) ||
        typeof currentRsi !== "number" || isNaN(currentRsi)
      ) {
        tfReasoning.push(`[TIMEFRAME FAIL-CLOSED] ${targetTimeframe} RSI contains invalid or NaN values.`);
        return { isAlignedBuy: false, isAlignedSell: false, tfReasoning, separation: sepTf, hasBuyCurl: false, hasSellCurl: false, previousRsi: 0, currentRsi: 0 };
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
        hasSellCurl,
        previousRsi,
        currentRsi
      };
    };

    // Evaluate market alignment at T and T_previous
    const currentAlignment = evaluateMarketAlignment(currentIndicatorSnapshot);

    let previousAlignment = { isAlignedBuy: false, isAlignedSell: false, tfReasoning: [] as string[], separation: 0, hasBuyCurl: false, hasSellCurl: false, previousRsi: 0, currentRsi: 0 };
    if (hasValidPreviousData && previousIndicatorSnapshot) {
      previousAlignment = evaluateMarketAlignment(previousIndicatorSnapshot);
    }

    const stateKey = `${context.marketSnapshot.symbol.toUpperCase()}:${targetTimeframe}`;

    // Edge transition: emit only when transitioning from NOT ALIGNED to ALIGNED
    const isNewBuyEvent = currentAlignment.isAlignedBuy && !previousAlignment.isAlignedBuy;
    const isNewSellEvent = currentAlignment.isAlignedSell && !previousAlignment.isAlignedSell;

    // Edge transition recovery: check if immediately preceding closed bar at T_previous had an established transiently rejected edge event
    const pendingRejected = this.rejectedEdgeEvents.get(stateKey);
    const isRecoveredBuyEvent = Boolean(
      pendingRejected &&
      pendingRejected.timestamp === T_previous &&
      pendingRejected.direction === SignalType.BUY &&
      currentAlignment.isAlignedBuy
    );
    const isRecoveredSellEvent = Boolean(
      pendingRejected &&
      pendingRejected.timestamp === T_previous &&
      pendingRejected.direction === SignalType.SELL &&
      currentAlignment.isAlignedSell
    );

    // Invalidation / Expiry / Direction reversal cleanup:
    if (pendingRejected && !isRecoveredBuyEvent && !isRecoveredSellEvent) {
      this.rejectedEdgeEvents.delete(stateKey);
    }

    const isEdgeBuy = isNewBuyEvent || isRecoveredBuyEvent;
    const isEdgeSell = isNewSellEvent || isRecoveredSellEvent;

    const reasoning: string[] = [...currentAlignment.tfReasoning];

    let targetSignalType: SignalType | null = null;
    if (isEdgeBuy) {
      targetSignalType = SignalType.BUY;
      reasoning.push(`Mean Reversion: Buy setup confirmed via oversold bounce on ${targetTimeframe}`);
      if (isRecoveredBuyEvent) {
        reasoning.push(`[${tfUpper} EDGE RECOVERY] Recovered BUY event: ${targetTimeframe} trigger recovered after transient rejection on previous bar.`);
      } else {
        reasoning.push(`[${tfUpper} EDGE EVENT] New BUY event: ${targetTimeframe} trigger transitioned from NOT ALIGNED to ALIGNED.`);
      }
    } else if (isEdgeSell) {
      if (this.manifest.supportsShort) {
        targetSignalType = SignalType.SELL;
        reasoning.push(`Mean Reversion: Sell setup confirmed via overbought rejection on ${targetTimeframe}`);
        if (isRecoveredSellEvent) {
          reasoning.push(`[${tfUpper} EDGE RECOVERY] Recovered SELL event: ${targetTimeframe} trigger recovered after transient rejection on previous bar.`);
        } else {
          reasoning.push(`[${tfUpper} EDGE EVENT] New SELL event: ${targetTimeframe} trigger transitioned from NOT ALIGNED to ALIGNED.`);
        }
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
      const primaryTfConfidence = currentConfidenceScore.timeframes[targetTimeframe];
      const directionalConfidence = (primaryTfConfidence?.score ?? 0);
      return this.createNoSignalResult(context, reasoning, targetTimeframe, currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
    }

    // 5. Risk validation downstream of edge transition
    const entryCandles = currentCandlesRecord[targetTimeframe]!;
    const latestCandleClose = entryCandles[entryCandles.length - 1]?.close || 0;
    const currentPrice = latestCandleClose > 0 ? latestCandleClose : context.marketSnapshot.currentPrice || 0;

    if (currentPrice <= 0) {
      this.rejectedEdgeEvents.delete(stateKey);
      return this.createNoSignalResult(context, ["Invalid current price (zero or negative)"], targetTimeframe, currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
    }

    if (!context.accountBalance || context.accountBalance <= 0) {
      if (isEdgeBuy) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.BUY, reason: 'ACCOUNT_BALANCE_UNAVAILABLE' });
      } else if (isEdgeSell) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.SELL, reason: 'ACCOUNT_BALANCE_UNAVAILABLE' });
      }
      return this.createNoSignalResult(context, ["Account balance is zero or unconfigured"], targetTimeframe, currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
    }

    // ATR risk calculation strictly on targetTimeframe ATR
    const tfIndicators = currentIndicatorSnapshot.timeframes[targetTimeframe];
    const atrArray = tfIndicators?.atr?.[this.config.conditionConfig.atrPeriod]; // 14
    let currentAtr = (atrArray && atrArray.length > 0) ? atrArray[atrArray.length - 1] : 0;

    if (!currentAtr || currentAtr <= 0 || isNaN(currentAtr)) {
      this.rejectedEdgeEvents.delete(stateKey);
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
      if (isEdgeBuy && currentAlignment.isAlignedBuy) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.BUY, reason: 'DISALLOWED_RISK_CLASSIFICATION' });
      } else if (isEdgeSell && currentAlignment.isAlignedSell) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.SELL, reason: 'DISALLOWED_RISK_CLASSIFICATION' });
      } else {
        this.rejectedEdgeEvents.delete(stateKey);
      }
      reasoning.push(`Mean Reversion: Risk classification ${riskAssessment.riskClassification} is not allowed by signal rules`);
      return this.createNoSignalResult(context, reasoning, targetTimeframe, currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
    }

    // 6. MeanReversion-Specific Reversal Confidence Evaluation
    const directionalScore = this.calculateReversalConfidence(
      targetSignalType,
      currentAlignment.previousRsi,
      currentAlignment.currentRsi,
      currentAlignment.separation,
      entryCandles,
      tfIndicators
    );

    if (directionalScore < this.config.signalRules.minConfidenceScore) {
      // Quality rejection: clear pending recovery and fail closed
      this.rejectedEdgeEvents.delete(stateKey);
      reasoning.push(`Mean Reversion confidence score (${directionalScore}) is below required minimum (${this.config.signalRules.minConfidenceScore}).`);
      return this.createNoSignalResult(context, reasoning, targetTimeframe, currentIndicatorSnapshot, currentConditionResult, currentConfidenceScore, customIndicators);
    }

    // Signal passed all validation, risk, and confidence gates: consume recovery state
    this.rejectedEdgeEvents.delete(stateKey);

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

    const primaryTfConfidence = currentConfidenceScore.timeframes[targetTimeframe];
    if (primaryTfConfidence) {
      primaryTfConfidence.score = directionalScore;
      if (targetSignalType === SignalType.BUY) {
        primaryTfConfidence.longScore = directionalScore;
      } else if (targetSignalType === SignalType.SELL) {
        primaryTfConfidence.shortScore = directionalScore;
      }
    }

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

  /**
   * Reversal Confidence Calculation (MeanReversion Specific)
   *
   * Measures genuine technical reversal evidence without double-counting risk:
   * 1. Reversal Curl Decisiveness (50%): Strength of momentum snapback (curl delta)
   *    and recovery exit out of the extreme zone.
   * 2. Exhaustion Depth (20%): Statistical extension into extreme oversold/overbought zone.
   * 3. Volume Participation (15%): Volume expansion/absorption on the reversal bar.
   *    Missing, zero, negative or non-finite volume fails closed to 0 points.
   * 4. Mean Extension (15%): Elastic displacement from moving average equilibrium.
   *    Missing, zero or non-finite separation fails closed to 0 points.
   *
   * Risk classification is NOT awarded confidence points (remains an independent safety gate).
   */
  private calculateReversalConfidence(
    type: SignalType,
    previousRsi: number,
    currentRsi: number,
    separation: number,
    entryCandles: NormalizedCandle[],
    tfIndicators: any
  ): number {
    // Fail-closed defensive guards on required RSI inputs
    if (
      typeof previousRsi !== 'number' || !isFinite(previousRsi) ||
      typeof currentRsi !== 'number' || !isFinite(currentRsi)
    ) {
      return 0;
    }

    // 1. Reversal Dynamics: Exhaustion Depth & Curl Velocity (Strictly Direction-Symmetric)
    let exhaustionDepth = 0;
    let curlDelta = 0;
    let hasExitedExtreme = false;

    if (type === SignalType.BUY) {
      exhaustionDepth = Math.max(0, this.config.conditionConfig.rsiOversold - previousRsi);
      curlDelta = Math.max(0, currentRsi - previousRsi);
      hasExitedExtreme = currentRsi >= this.config.conditionConfig.rsiOversold;
    } else if (type === SignalType.SELL) {
      exhaustionDepth = Math.max(0, previousRsi - this.config.conditionConfig.rsiOverbought);
      curlDelta = Math.max(0, previousRsi - currentRsi);
      hasExitedExtreme = currentRsi <= this.config.conditionConfig.rsiOverbought;
    } else {
      return 0;
    }

    // Exhaustion Depth Score (Weight: 20%):
    // Depth 0 (at boundary 25/75) = 20 pts. Depth >= 5 (RSI <= 20 / >= 80) = 100 pts.
    const depthScore = Math.min(100, Math.round(20 + exhaustionDepth * 16));

    // Curl Velocity Score (Weight: 50%):
    // A marginal 0.5 - 1.0 point bounce scores very low (<= 20).
    // A decisive curl >= 5.0 points scores 100.
    // If RSI has not yet exited the extreme zone, curl score is capped at 60.
    let rawCurlScore = 0;
    if (curlDelta <= 1.0) {
      rawCurlScore = Math.round(curlDelta * 20); // 0.5 -> 10, 1.0 -> 20
    } else {
      rawCurlScore = Math.min(100, Math.round(20 + (curlDelta - 1.0) * 20)); // 2.0 -> 40, 3.0 -> 60, 4.0 -> 80, 5.0 -> 100
    }
    const curlScore = hasExitedExtreme ? rawCurlScore : Math.min(60, rawCurlScore);

    // 2. Volume Participation Score (Weight: 15%):
    // Missing, zero, negative or non-finite volume scores 0.
    let volumeScore = 0;
    const latestCandle = (entryCandles && entryCandles.length > 0) ? entryCandles[entryCandles.length - 1] : null;
    const latestVolume = latestCandle?.volume;

    let avgVolume = 0;
    if (tfIndicators?.volume && tfIndicators.volume.length > 0) {
      const volEntry = tfIndicators.volume[tfIndicators.volume.length - 1];
      avgVolume = typeof volEntry === 'number' ? volEntry : (volEntry?.averageVolume ?? 0);
    }

    if (
      typeof latestVolume === 'number' && isFinite(latestVolume) && latestVolume > 0 &&
      typeof avgVolume === 'number' && isFinite(avgVolume) && avgVolume > 0
    ) {
      const volumeRatio = latestVolume / avgVolume;
      if (volumeRatio >= 1.5) {
        volumeScore = 100;
      } else if (volumeRatio >= 1.0) {
        volumeScore = 85;
      } else if (volumeRatio >= 0.75) {
        volumeScore = 50;
      } else {
        volumeScore = 25;
      }
    } else {
      volumeScore = 0; // Fail closed: no positive volume credit without confirmed volume data
    }

    // 3. Mean Extension / Separation Score (Weight: 15%):
    // Missing, zero, negative or non-finite separation scores 0.
    let separationScore = 0;
    if (typeof separation === 'number' && isFinite(separation) && separation > 0) {
      if (separation >= 1.0 && separation <= this.config.trendFilter.maxEmaSeparationPercent) {
        separationScore = 100;
      } else if (separation > 0 && separation < 1.0) {
        separationScore = Math.round(separation * 80);
      } else if (separation > this.config.trendFilter.maxEmaSeparationPercent) {
        separationScore = 20; // Penalized for runaway trend
      }
    } else {
      separationScore = 0; // Fail closed
    }

    // Weighted Sum: Curl (50%), Depth (20%), Volume (15%), Separation (15%) = 100%
    const W_CURL = 50;
    const W_DEPTH = 20;
    const W_VOLUME = 15;
    const W_SEPARATION = 15;
    const TOTAL_WEIGHT = W_CURL + W_DEPTH + W_VOLUME + W_SEPARATION;

    const weightedSum =
      (curlScore * W_CURL) +
      (depthScore * W_DEPTH) +
      (volumeScore * W_VOLUME) +
      (separationScore * W_SEPARATION);

    const finalScore = Math.round(weightedSum / TOTAL_WEIGHT);
    return Math.min(100, Math.max(0, finalScore));
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
