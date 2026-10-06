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
function getCandleCloseTime(candle: NormalizedCandle, tf: Timeframe): number {
  if (typeof (candle as any).closeTime === 'number' && (candle as any).closeTime > 0) {
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

  constructor(private config: BreakoutConfig = DEFAULT_BREAKOUT_CONFIG) {
    this.indicatorEngine = new IndicatorEngine(config.indicatorConfig);
    this.conditionEngine = new ConditionEngine(config.conditionConfig);
    this.confidenceEngine = new ConfidenceEngine(config.confidenceWeights);
    this.riskEngine = new RiskEngine(config.riskParameters);
    this.signalEngine = new SignalEngine(config.signalRules);
  }

  public evaluate(context: Readonly<StrategyContext>, targetTimeframe: Timeframe): EvaluationResult {
    const MIN_CLOSED_CANDLES = 35; // Derived from MACD(12, 26, 9) signal line lookback requirement

    // 0. Fail-Closed Validation: Ensure targetTimeframe is supported by manifest
    if (!this.manifest.supportedTimeframes.includes(targetTimeframe)) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: [`Unsupported timeframe ${targetTimeframe} for ${this.manifest.id}`],
          signal: null,
          strategyConfig: this.config,
          targetTimeframe,
        }
      };
    }

    // 1. Snapshot Evaluation Reference Time (T & T_previous)
    const rawCandles = context.marketSnapshot?.candles?.[targetTimeframe];
    if (!rawCandles || rawCandles.length === 0) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: [`[TIMEFRAME DATA] Missing required candle data for timeframe ${targetTimeframe}`],
          signal: null,
          strategyConfig: this.config,
          targetTimeframe,
        }
      };
    }

    // Filter forming candles: only closed candles at or before context.timestamp
    const closedCandlesAtRef = rawCandles.filter(c => getCandleCloseTime(c, targetTimeframe) <= context.timestamp);
    if (closedCandlesAtRef.length < MIN_CLOSED_CANDLES) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: [`[TIMEFRAME DATA] Insufficient closed candle data for timeframe ${targetTimeframe} (got ${closedCandlesAtRef.length}, required >= ${MIN_CLOSED_CANDLES})`],
          signal: null,
          strategyConfig: this.config,
          targetTimeframe,
        }
      };
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
    const currentConditionResult = this.conditionEngine.evaluate(currentIndicatorSnapshot);
    const currentConfidenceScore = this.confidenceEngine.evaluate(currentConditionResult);

    // Previous technical evaluation
    let previousIndicatorSnapshot: any = null;
    let previousConditionResult: any = null;
    let previousConfidenceScore: any = null;

    const hasValidPreviousData = Boolean(previousCandlesRecord[targetTimeframe] && previousCandlesRecord[targetTimeframe]!.length >= MIN_CLOSED_CANDLES);

    if (hasValidPreviousData) {
      previousIndicatorSnapshot = this.indicatorEngine.evaluate(snapshotPrevious);
      previousConditionResult = this.conditionEngine.evaluate(previousIndicatorSnapshot);
      previousConfidenceScore = this.confidenceEngine.evaluate(previousConditionResult);
    }

    // 4. Pure Market Alignment Helper (Authoritative on targetTimeframe Trigger)
    const evaluateMarketAlignment = (
      conditionRes: ConditionResult,
      confidenceSc: ConfidenceScore,
      entryCandles: NormalizedCandle[]
    ): { isAlignedBuy: boolean; isAlignedSell: boolean } => {
      // Check targetTimeframe SignalEngine trigger with nominal risk (pure market evaluation)
      const lastClose = entryCandles[entryCandles.length - 1]?.close || 0;
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
    if (hasValidPreviousData && previousConditionResult && previousConfidenceScore) {
      previousAlignment = evaluateMarketAlignment(
        previousConditionResult,
        previousConfidenceScore,
        previousCandlesRecord[targetTimeframe]!
      );
    }

    // Edge transition: emit only when transitioning from NOT ALIGNED to ALIGNED
    const isNewBuyEvent = currentAlignment.isAlignedBuy && !previousAlignment.isAlignedBuy;
    const isNewSellEvent = currentAlignment.isAlignedSell && !previousAlignment.isAlignedSell;

    // 5. Evaluate Current Real Risk Gates
    const entryCandles = currentCandlesRecord[targetTimeframe]!;
    const latestCandleClose = entryCandles[entryCandles.length - 1]?.close || 0;
    const currentPrice = latestCandleClose > 0 ? latestCandleClose : context.marketSnapshot.currentPrice || 0;

    if (currentPrice <= 0) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ["Invalid current price (zero or negative)"], targetTimeframe }
      };
    }

    if (!context.accountBalance || context.accountBalance <= 0) {
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
    const currentAtr = (atrArray && atrArray.length > 0) ? atrArray[atrArray.length - 1] : 0;

    if (!currentAtr || currentAtr <= 0) {
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

    // 7. Apply Edge Transition Gate (Anti-Chase Protection)
    const tfUpper = targetTimeframe.toUpperCase();
    if (isNewBuyEvent && activeSignal?.type === SignalType.BUY) {
      reasoning.push(`[${tfUpper} EDGE EVENT] New BUY event: ${targetTimeframe} trigger transitioned from NOT ALIGNED to ALIGNED.`);
    } else if (isNewSellEvent && activeSignal?.type === SignalType.SELL) {
      reasoning.push(`[${tfUpper} EDGE EVENT] New SELL event: ${targetTimeframe} trigger transitioned from NOT ALIGNED to ALIGNED.`);
    } else {
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
