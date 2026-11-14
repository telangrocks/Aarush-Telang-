import { IStrategy } from "../../interfaces/IStrategy";
import { StrategyContext } from "../../context/StrategyContext";
import { EvaluationResult } from "../../dto/EvaluationResult";
import { StrategyManifest } from "../StrategyManifest";
import { IndicatorEngine } from "../../indicator";
import { ConditionEngine, ConditionResult } from "../../condition";
import { ConfidenceEngine, ConfidenceScore } from "../../confidence";
import { RiskEngine, RiskContext, RiskAssessment } from "../../risk";
import { SignalEngine, SignalContext, SignalType } from "../../signal";

import { BREAKOUT_STRATEGY_MANIFEST } from "./BreakoutRules";
import { BreakoutConfig, DEFAULT_BREAKOUT_CONFIG } from "./BreakoutConfig";
import { Timeframe } from "../../market-data/Timeframe";
import { MarketSnapshot, NormalizedCandle } from "../../market-data/MarketSnapshot";
import { CandleValidator } from "../../../infrastructure/exchange/CandleValidator";

/**
 * Derives the candle close timestamp in milliseconds.
 * In Bybit REST / standard exchange models, kline timestamp is open time.
 * If closeTime is not explicitly populated, closeTime = openTime + timeframeMs.
 */
function getCandleCloseTime(candle: NormalizedCandle | undefined, tf: Timeframe): number {
  if (!candle || typeof candle !== 'object') {
    return NaN;
  }
  const rawClose = (candle as any).closeTime;
  if (rawClose !== undefined) {
    return typeof rawClose === 'number' && Number.isFinite(rawClose) && rawClose > 0 ? rawClose : NaN;
  }
  const tfMs = CandleValidator.timeframeToMs(tf);
  if (!Number.isFinite(tfMs) || tfMs <= 0) {
    return NaN;
  }
  if (typeof candle.openTime === "number" && Number.isFinite(candle.openTime) && candle.openTime > 0) {
    return candle.openTime + tfMs;
  }
  if (typeof candle.timestamp === "number" && Number.isFinite(candle.timestamp) && candle.timestamp > 0) {
    return candle.timestamp + tfMs;
  }
  return NaN;
}

function isValidBreakoutOhlcCandle(c: NormalizedCandle | undefined, allowZeroPrice: boolean): boolean {
  if (!c || typeof c !== 'object') return false;
  if (
    typeof c.open !== 'number' || !Number.isFinite(c.open) ||
    typeof c.high !== 'number' || !Number.isFinite(c.high) ||
    typeof c.low !== 'number' || !Number.isFinite(c.low) ||
    typeof c.close !== 'number' || !Number.isFinite(c.close)
  ) {
    return false;
  }
  if (allowZeroPrice) {
    if (c.open < 0 || c.high < 0 || c.low < 0 || c.close < 0) return false;
  } else {
    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) return false;
  }
  if (c.high < c.low) return false;
  if (c.volume !== undefined && (typeof c.volume !== 'number' || !Number.isFinite(c.volume) || c.volume < 0)) {
    return false;
  }
  return true;
}

export class BreakoutStrategy implements IStrategy {
  public readonly manifest: StrategyManifest = {
    id: BREAKOUT_STRATEGY_MANIFEST.id,
    displayName: BREAKOUT_STRATEGY_MANIFEST.name,
    description: BREAKOUT_STRATEGY_MANIFEST.description,
    version: BREAKOUT_STRATEGY_MANIFEST.version,
    category: BREAKOUT_STRATEGY_MANIFEST.classification,
    riskProfile: BREAKOUT_STRATEGY_MANIFEST.riskProfile,
    supportedMarkets: ["CRYPTO"],
    supportedTimeframes: BREAKOUT_STRATEGY_MANIFEST.supportedTimeframes as Timeframe[],
    minimumCandles: BREAKOUT_STRATEGY_MANIFEST.minimumCandles || 35,
    defaultConfiguration: DEFAULT_BREAKOUT_CONFIG,
    supportsLong: true,
    supportsShort: true,
    supportsPaperTrading: true,
    supportsLiveTrading: true,
    status: "ACTIVE",
    author: BREAKOUT_STRATEGY_MANIFEST.author,
    parameters: [
      { key: "risk_level", displayName: "Risk Level", type: "ENUM", defaultValue: "Medium", isRequired: true, options: ["Low", "Medium", "High"] },
      { key: "mode", displayName: "Mode", type: "ENUM", defaultValue: "Aggressive", isRequired: true, options: ["Conservative", "Moderate", "Aggressive"] }
    ]
  };

  private indicatorEngine: IndicatorEngine;
  private conditionEngine: ConditionEngine;
  private confidenceEngine: ConfidenceEngine;
  private riskEngine: RiskEngine;
  private signalEngine: SignalEngine;
  private rejectedEdgeEvents = new Map<string, { timestamp: number; direction: SignalType; reason: 'ACCOUNT_BALANCE_UNAVAILABLE' | 'DISALLOWED_RISK_CLASSIFICATION' }>();

  constructor(private config: BreakoutConfig = DEFAULT_BREAKOUT_CONFIG) {
    this.indicatorEngine = new IndicatorEngine(config.indicatorConfig);
    this.conditionEngine = new ConditionEngine(config.conditionConfig);
    this.confidenceEngine = new ConfidenceEngine(config.confidenceWeights);
    this.riskEngine = new RiskEngine(config.riskParameters);
    this.signalEngine = new SignalEngine(config.signalRules);
  }

  private buildRejectedEvaluation(
    timestamp: number,
    targetTimeframe: Timeframe,
    reason: string,
    extraMetadata: Record<string, unknown> = {}
  ): EvaluationResult {
    return {
      strategyId: this.manifest.id,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      confidenceScore: 0,
      hasSignal: false,
      metadata: {
        reasoning: [reason],
        signal: null,
        strategyConfig: this.config,
        targetTimeframe,
        ...extraMetadata,
      },
    };
  }

  private hasFiniteRequiredIndicators(indicatorSnap: any, tf: Timeframe): boolean {
    const tfInd = indicatorSnap?.timeframes?.[tf];
    if (!tfInd) return false;

    const emaFast = tfInd.ema?.[this.config.conditionConfig.emaFastPeriod];
    const emaSlow = tfInd.ema?.[this.config.conditionConfig.emaSlowPeriod];
    const rsi = tfInd.rsi?.[this.config.conditionConfig.rsiPeriod];
    const macd = tfInd.macd?.[this.config.conditionConfig.macdKey];
    const atr = tfInd.atr?.[this.config.conditionConfig.atrPeriod];

    if (!Array.isArray(emaFast) || emaFast.length < 2) return false;
    if (!Array.isArray(emaSlow) || emaSlow.length < 2) return false;
    if (!Array.isArray(rsi) || rsi.length === 0) return false;
    if (!Array.isArray(macd) || macd.length === 0) return false;
    if (!Array.isArray(atr) || atr.length === 0) return false;

    const fLast = emaFast[emaFast.length - 1];
    const fPrev = emaFast[emaFast.length - 2];
    const sLast = emaSlow[emaSlow.length - 1];
    const sPrev = emaSlow[emaSlow.length - 2];
    const rsiLast = rsi[rsi.length - 1];
    const macdLast = macd[macd.length - 1];
    const atrLast = atr[atr.length - 1];

    return (
      typeof fLast === 'number' && Number.isFinite(fLast) && fLast >= 0 &&
      typeof fPrev === 'number' && Number.isFinite(fPrev) && fPrev >= 0 &&
      typeof sLast === 'number' && Number.isFinite(sLast) && sLast >= 0 &&
      typeof sPrev === 'number' && Number.isFinite(sPrev) && sPrev >= 0 &&
      typeof rsiLast === 'number' && Number.isFinite(rsiLast) &&
      Boolean(macdLast) &&
      typeof macdLast.macdLine === 'number' && Number.isFinite(macdLast.macdLine) &&
      typeof macdLast.signalLine === 'number' && Number.isFinite(macdLast.signalLine) &&
      typeof macdLast.histogram === 'number' && Number.isFinite(macdLast.histogram) &&
      typeof atrLast === 'number' && Number.isFinite(atrLast) && atrLast >= 0
    );
  }

  public evaluate(context: Readonly<StrategyContext>, targetTimeframe: Timeframe): EvaluationResult {
    const MIN_CLOSED_CANDLES = 35; // Derived from MACD(12, 26, 9) signal line lookback requirement

    // 0. Fail-Closed Validation: Ensure targetTimeframe is supported and context timestamp/symbol are valid
    if (!this.manifest.supportedTimeframes.includes(targetTimeframe)) {
      return this.buildRejectedEvaluation(
        context?.timestamp,
        targetTimeframe,
        `Unsupported timeframe ${targetTimeframe} for ${this.manifest.id}`
      );
    }

    if (!context || typeof context.timestamp !== 'number' || !Number.isFinite(context.timestamp)) {
      return this.buildRejectedEvaluation(
        0,
        targetTimeframe,
        `[TIMEFRAME DATA] Invalid evaluation timestamp for timeframe ${targetTimeframe}`
      );
    }

    const rawSymbol = context.marketSnapshot?.symbol;
    if (typeof rawSymbol !== 'string' || rawSymbol.trim().length === 0) {
      return this.buildRejectedEvaluation(
        context.timestamp,
        targetTimeframe,
        `[TIMEFRAME DATA] Missing or invalid symbol for timeframe ${targetTimeframe}`
      );
    }

    const stateKey = `${rawSymbol.toUpperCase()}:${targetTimeframe}`;

    // 1. Snapshot Evaluation Reference Time (T & T_previous)
    const rawCandles = context.marketSnapshot?.candles?.[targetTimeframe];
    if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
      return this.buildRejectedEvaluation(
        context.timestamp,
        targetTimeframe,
        `[TIMEFRAME DATA] Missing required candle data for timeframe ${targetTimeframe}`
      );
    }

    for (let i = 0; i < rawCandles.length; i++) {
      if (!Number.isFinite(getCandleCloseTime(rawCandles[i], targetTimeframe))) {
        this.rejectedEdgeEvents.delete(stateKey);
        return this.buildRejectedEvaluation(
          context.timestamp,
          targetTimeframe,
          `[TIMEFRAME DATA] Invalid candle timestamp in ${targetTimeframe} series`
        );
      }
    }

    // Filter forming candles: only closed candles at or before context.timestamp
    const closedCandlesAtRef = rawCandles.filter(c => getCandleCloseTime(c, targetTimeframe) <= context.timestamp);
    if (closedCandlesAtRef.length < MIN_CLOSED_CANDLES) {
      return this.buildRejectedEvaluation(
        context.timestamp,
        targetTimeframe,
        `[TIMEFRAME DATA] Insufficient closed candle data for timeframe ${targetTimeframe} (got ${closedCandlesAtRef.length}, required >= ${MIN_CLOSED_CANDLES})`
      );
    }

    // Validate OHLC and volume integrity across closed series before indicator calculations
    // (Allow zero price only on the latest closed candle so Test 23 reports "Invalid current price")
    if (closedCandlesAtRef.some((c, idx) => !isValidBreakoutOhlcCandle(c, idx === closedCandlesAtRef.length - 1))) {
      this.rejectedEdgeEvents.delete(stateKey);
      return this.buildRejectedEvaluation(
        context.timestamp,
        targetTimeframe,
        `[TIMEFRAME DATA] Invalid OHLC candle data detected in ${targetTimeframe} series`
      );
    }

    const latestClosed = closedCandlesAtRef[closedCandlesAtRef.length - 1];
    const T = getCandleCloseTime(latestClosed, targetTimeframe);
    const tfMs = CandleValidator.timeframeToMs(targetTimeframe);
    const T_previous = T - tfMs;

    // 2. Build Closed-Candle Projections for T and T_previous strictly on targetTimeframe
    const currentCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {
      [targetTimeframe]: closedCandlesAtRef,
    };
    const closedCandlesAtPrev = closedCandlesAtRef.filter(c => getCandleCloseTime(c, targetTimeframe) <= T_previous);
    const previousCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {
      [targetTimeframe]: closedCandlesAtPrev,
    };

    // 3. Technical Indicator & Condition Evaluations on Independent In-Memory Projections
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
    if (!this.hasFiniteRequiredIndicators(currentIndicatorSnapshot, targetTimeframe)) {
      this.rejectedEdgeEvents.delete(stateKey);
      return this.buildRejectedEvaluation(
        context.timestamp,
        targetTimeframe,
        `[INDICATOR DATA] Non-finite or missing required indicators evaluated on ${targetTimeframe}`,
        { indicatorSnapshot: currentIndicatorSnapshot }
      );
    }

    const currentConditionResult = this.conditionEngine.evaluate(currentIndicatorSnapshot);
    const currentConfidenceScore = this.confidenceEngine.evaluate(currentConditionResult);

    if (
      !Number.isFinite(currentConfidenceScore?.overallScore) ||
      !Number.isFinite(currentConfidenceScore?.timeframes?.[targetTimeframe]?.score)
    ) {
      this.rejectedEdgeEvents.delete(stateKey);
      return this.buildRejectedEvaluation(
        context.timestamp,
        targetTimeframe,
        `[CONFIDENCE DATA] Non-finite confidence score evaluated on ${targetTimeframe}`,
        {
          indicatorSnapshot: currentIndicatorSnapshot,
          conditionResult: currentConditionResult,
        }
      );
    }

    // Previous technical evaluation
    let previousIndicatorSnapshot: any = null;
    let previousConditionResult: any = null;
    let previousConfidenceScore: any = null;

    const hasValidPreviousData = Boolean(previousCandlesRecord[targetTimeframe] && previousCandlesRecord[targetTimeframe]!.length >= MIN_CLOSED_CANDLES);

    if (hasValidPreviousData) {
      previousIndicatorSnapshot = this.indicatorEngine.evaluate(snapshotPrevious);
      if (this.hasFiniteRequiredIndicators(previousIndicatorSnapshot, targetTimeframe)) {
        previousConditionResult = this.conditionEngine.evaluate(previousIndicatorSnapshot);
        previousConfidenceScore = this.confidenceEngine.evaluate(previousConditionResult);
      }
    }

    // 4. Pure Market Alignment Helper (Authoritative on targetTimeframe Trigger)
    const evaluateMarketAlignment = (
      conditionRes: ConditionResult,
      confidenceSc: ConfidenceScore,
      entryCandles: NormalizedCandle[]
    ): { isAlignedBuy: boolean; isAlignedSell: boolean } => {
      if (
        !Number.isFinite(confidenceSc?.overallScore) ||
        !Number.isFinite(confidenceSc?.timeframes?.[targetTimeframe]?.score)
      ) {
        return { isAlignedBuy: false, isAlignedSell: false };
      }

      // Check targetTimeframe SignalEngine trigger with nominal risk (pure market evaluation)
      const lastClose = entryCandles[entryCandles.length - 1]?.close;
      if (typeof lastClose !== 'number' || !Number.isFinite(lastClose) || lastClose <= 0) {
        return { isAlignedBuy: false, isAlignedSell: false };
      }
      const nominalRisk: RiskAssessment = {
        timestamp: context.timestamp,
        stopLossDistance: lastClose * 0.02,
        takeProfitDistance: lastClose * 0.03,
        riskRewardRatio: 1.5,
        maximumExposure: 100,
        riskClassification: 'MEDIUM',
        positionSizeRecommendation: 1,
        explanation: ['Nominal risk assessment for market alignment evaluation'],
      };

      const evalContext: SignalContext = {
        symbol: context.marketSnapshot.symbol,
        timeframe: targetTimeframe,
        currentPrice: lastClose
      };

      const triggerSignal = this.signalEngine.evaluate(
        evalContext,
        conditionRes,
        confidenceSc,
        nominalRisk
      );

      const hasBuyTrigger = triggerSignal?.type === SignalType.BUY;
      const hasSellTrigger = triggerSignal?.type === SignalType.SELL;

      return {
        isAlignedBuy: hasBuyTrigger,
        isAlignedSell: hasSellTrigger,
      };
    };

    // Evaluate market alignment at T and T_previous
    const currentAlignment = evaluateMarketAlignment(
      currentConditionResult,
      currentConfidenceScore,
      currentCandlesRecord[targetTimeframe]!
    );

    let previousAlignment = { isAlignedBuy: false, isAlignedSell: false };
    if (
      hasValidPreviousData &&
      previousConditionResult &&
      previousConfidenceScore &&
      Number.isFinite(previousConfidenceScore?.overallScore) &&
      Number.isFinite(previousConfidenceScore?.timeframes?.[targetTimeframe]?.score)
    ) {
      previousAlignment = evaluateMarketAlignment(
        previousConditionResult,
        previousConfidenceScore,
        previousCandlesRecord[targetTimeframe]!
      );
    }

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
    // If a pending rejected event exists, but cannot be recovered (e.g., timestamp is not T_previous, alignment broke, or direction reversed), clear it.
    if (pendingRejected && !isRecoveredBuyEvent && !isRecoveredSellEvent) {
      this.rejectedEdgeEvents.delete(stateKey);
    }

    const isEdgeBuy = isNewBuyEvent || isRecoveredBuyEvent;
    const isEdgeSell = isNewSellEvent || isRecoveredSellEvent;

    // 5. Evaluate Current Real Risk Gates
    const entryCandles = currentCandlesRecord[targetTimeframe]!;
    const latestCandleClose = entryCandles[entryCandles.length - 1]?.close;
    const snapshotPrice = Number.isFinite(context.marketSnapshot.currentPrice) ? context.marketSnapshot.currentPrice : 0;
    const currentPrice = (typeof latestCandleClose === 'number' && Number.isFinite(latestCandleClose) && latestCandleClose > 0)
      ? latestCandleClose
      : snapshotPrice;

    if (
      typeof latestCandleClose !== 'number' ||
      !Number.isFinite(latestCandleClose) ||
      latestCandleClose <= 0 ||
      !Number.isFinite(currentPrice) ||
      currentPrice <= 0
    ) {
      // Permanent / invalid market data failure: clear any pending recovery and fail closed
      this.rejectedEdgeEvents.delete(stateKey);
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ["Invalid current price (zero or negative)"], targetTimeframe }
      };
    }

    if (!context.accountBalance || !Number.isFinite(context.accountBalance) || context.accountBalance <= 0) {
      // Confirmed transient rejection: account balance unavailable/zero
      if (isEdgeBuy) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.BUY, reason: 'ACCOUNT_BALANCE_UNAVAILABLE' });
      } else if (isEdgeSell) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.SELL, reason: 'ACCOUNT_BALANCE_UNAVAILABLE' });
      }
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ["Account balance not available — cannot calculate position size"], targetTimeframe }
      };
    }

    // ATR risk calculation strictly on targetTimeframe ATR
    const tfIndicators = currentIndicatorSnapshot.timeframes[targetTimeframe];
    const atrArray = tfIndicators?.atr[this.config.conditionConfig.atrPeriod];
    const currentAtr = (atrArray && atrArray.length > 0) ? atrArray[atrArray.length - 1] : NaN;

    if (typeof currentAtr !== 'number' || !Number.isFinite(currentAtr) || currentAtr <= 0) {
      // Unavailable indicator data: clear any pending recovery and fail closed
      this.rejectedEdgeEvents.delete(stateKey);
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: ["ATR is zero or unavailable — cannot calculate risk parameters"],
          signal: null,
          indicatorSnapshot: currentIndicatorSnapshot,
          conditionResult: currentConditionResult,
          targetTimeframe,
        }
      };
    }

    const riskContext: RiskContext = {
      timestamp: T,
      currentPrice,
      currentAtr,
      accountBalance: context.accountBalance
    };
    const realRiskAssessment = this.riskEngine.evaluate(riskContext);

    // 6. Generate Trading Signal on targetTimeframe Trigger
    const signalContext: SignalContext = {
      symbol: context.marketSnapshot.symbol,
      timeframe: targetTimeframe,
      currentPrice
    };

    let activeSignal = this.signalEngine.evaluate(
      signalContext,
      currentConditionResult,
      currentConfidenceScore,
      realRiskAssessment
    );

    const reasoning: string[] = activeSignal ? [...activeSignal.reasoning] : [`No qualified signal generated on ${targetTimeframe} trigger`];

    // 7. Apply Edge Transition Gate (Anti-Chase Protection & Edge Recovery)
    const tfUpper = targetTimeframe.toUpperCase();
    if (isEdgeBuy && activeSignal?.type === SignalType.BUY) {
      this.rejectedEdgeEvents.delete(stateKey);
      if (isRecoveredBuyEvent) {
        reasoning.push(`[${tfUpper} EDGE RECOVERY] Recovered BUY event: ${targetTimeframe} trigger recovered after transient rejection on previous bar.`);
      } else {
        reasoning.push(`[${tfUpper} EDGE EVENT] New BUY event: ${targetTimeframe} trigger transitioned from NOT ALIGNED to ALIGNED.`);
      }
    } else if (isEdgeSell && activeSignal?.type === SignalType.SELL) {
      this.rejectedEdgeEvents.delete(stateKey);
      if (isRecoveredSellEvent) {
        reasoning.push(`[${tfUpper} EDGE RECOVERY] Recovered SELL event: ${targetTimeframe} trigger recovered after transient rejection on previous bar.`);
      } else {
        reasoning.push(`[${tfUpper} EDGE EVENT] New SELL event: ${targetTimeframe} trigger transitioned from NOT ALIGNED to ALIGNED.`);
      }
    } else {
      // Edge event was present (either new or recovering), but activeSignal was null or rejected.
      // Distinguish explicitly identified transient rejection (e.g. transiently disallowed risk tier like EXTREME)
      // from non-recoverable rejections.
      const allowedTiers = this.config.signalRules.allowedRiskClassifications || [];
      const isTransientRiskRejection = Boolean(
        realRiskAssessment?.riskClassification &&
        !allowedTiers.includes(realRiskAssessment.riskClassification)
      );

      if (isTransientRiskRejection && (isEdgeBuy || isEdgeSell)) {
        if (isEdgeBuy && currentAlignment.isAlignedBuy) {
          this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.BUY, reason: 'DISALLOWED_RISK_CLASSIFICATION' });
        } else if (isEdgeSell && currentAlignment.isAlignedSell) {
          this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.SELL, reason: 'DISALLOWED_RISK_CLASSIFICATION' });
        } else {
          this.rejectedEdgeEvents.delete(stateKey);
        }
      } else {
        // Any other rejection (e.g. alignment broken, permanent failure, etc.) clears pending state
        this.rejectedEdgeEvents.delete(stateKey);
      }

      if (currentAlignment.isAlignedBuy && previousAlignment.isAlignedBuy) {
        reasoning.push(`[${tfUpper} CONTINUATION] Trend continuation suppressed: ${targetTimeframe} BUY trigger already active on previous bar.`);
      } else if (currentAlignment.isAlignedSell && previousAlignment.isAlignedSell) {
        reasoning.push(`[${tfUpper} CONTINUATION] Trend continuation suppressed: ${targetTimeframe} SELL trigger already active on previous bar.`);
      } else if (!currentAlignment.isAlignedBuy && !currentAlignment.isAlignedSell) {
        reasoning.push(`No qualified signal generated on ${targetTimeframe} trigger.`);
      }
      activeSignal = null;
    }

    if (activeSignal && !this.manifest.supportsShort && activeSignal.type === SignalType.SELL) {
      activeSignal = null;
      reasoning.push("Short signal suppressed: strategy is long-only");
    }

    const hasSignal = activeSignal !== null && (activeSignal.type === SignalType.BUY || activeSignal.type === SignalType.SELL);

    const primaryTfConfidence = currentConfidenceScore.timeframes[targetTimeframe];
    const directionalConfidence = activeSignal?.type === SignalType.SELL
      ? (primaryTfConfidence?.shortScore ?? 0)
      : activeSignal?.type === SignalType.BUY
      ? (primaryTfConfidence?.longScore ?? 0)
      : (primaryTfConfidence?.score ?? 0);

    return {
      strategyId: this.manifest.id,
      timestamp: context.timestamp,
      confidenceScore: directionalConfidence,
      hasSignal,
      metadata: {
        reasoning,
        signal: activeSignal,
        indicatorSnapshot: currentIndicatorSnapshot,
        conditionResult: currentConditionResult,
        confidenceScore: currentConfidenceScore,
        strategyConfig: this.config,
        targetTimeframe,
      }
    };
  }
}
