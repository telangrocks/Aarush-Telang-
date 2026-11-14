import { IStrategy } from '../../interfaces/IStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { EvaluationResult } from '../../dto/EvaluationResult';
import { MomentumConfig, DEFAULT_MOMENTUM_CONFIG } from './MomentumConfig';
import { MOMENTUM_STRATEGY_MANIFEST } from './MomentumRules';

import { IndicatorEngine } from '../../indicator/IndicatorEngine';
import { ConditionEngine } from '../../condition/ConditionEngine';
import { ConditionResult } from '../../condition/ConditionTypes';
import { ConfidenceEngine } from '../../confidence/ConfidenceEngine';
import { ConfidenceScore } from '../../confidence/ConfidenceScore';
import { RiskEngine, RiskContext, RiskAssessment } from '../../risk';
import { SignalEngine, SignalContext, SignalType } from '../../signal';
import { CandleValidator } from '../../../infrastructure/exchange/CandleValidator';
import { MarketSnapshot, NormalizedCandle } from '../../market-data/MarketSnapshot';
import { Timeframe } from '../../market-data/Timeframe';

import { StrategyManifest } from '../StrategyManifest';

export class MomentumStrategy implements IStrategy {
  public readonly manifest: StrategyManifest = {
    id: MOMENTUM_STRATEGY_MANIFEST.id,
    displayName: MOMENTUM_STRATEGY_MANIFEST.name,
    description: MOMENTUM_STRATEGY_MANIFEST.description,
    version: MOMENTUM_STRATEGY_MANIFEST.version,
    category: MOMENTUM_STRATEGY_MANIFEST.classification,
    riskProfile: MOMENTUM_STRATEGY_MANIFEST.riskProfile,
    supportedMarkets: ['CRYPTO'],
    supportedTimeframes: MOMENTUM_STRATEGY_MANIFEST.supportedTimeframes as any,
    minimumCandles: 201,
    defaultConfiguration: DEFAULT_MOMENTUM_CONFIG,
    supportsLong: true,
    supportsShort: true,
    supportsPaperTrading: true,
    supportsLiveTrading: true,
    status: 'ACTIVE',
    author: MOMENTUM_STRATEGY_MANIFEST.author,
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
  private rejectedEdgeEvents = new Map<string, { timestamp: number; direction: SignalType }>();

  constructor(private config: MomentumConfig = DEFAULT_MOMENTUM_CONFIG) {
    this.indicatorEngine = new IndicatorEngine(config.indicatorConfig);
    this.conditionEngine = new ConditionEngine(config.conditionConfig);
    this.confidenceEngine = new ConfidenceEngine(config.confidenceWeights);
    this.riskEngine = new RiskEngine(config.riskParameters);
    this.signalEngine = new SignalEngine(config.signalRules);
  }

  public evaluate(context: Readonly<StrategyContext>, targetTimeframe: Timeframe): EvaluationResult {
    const MIN_CLOSED_CANDLES = 201;

    // Helper: Derive candle close time deterministically; return NaN if timestamps are non-finite/missing
    const getCandleCloseTime = (c: NormalizedCandle, tf: string): number => {
      if (!c || typeof c !== 'object') return NaN;
      const rawClose = (c as any).closeTime;
      if (rawClose !== undefined) {
        return typeof rawClose === 'number' && Number.isFinite(rawClose) ? rawClose : NaN;
      }
      const baseTime = c.openTime ?? c.timestamp;
      if (typeof baseTime !== 'number' || !Number.isFinite(baseTime)) {
        return NaN;
      }
      return baseTime + CandleValidator.timeframeToMs(tf);
    };

    const isValidOhlcCandle = (c: NormalizedCandle | undefined): boolean => {
      if (!c || typeof c !== 'object') return false;
      if (
        !Number.isFinite(c.open) || c.open <= 0 ||
        !Number.isFinite(c.high) || c.high <= 0 ||
        !Number.isFinite(c.low) || c.low <= 0 ||
        !Number.isFinite(c.close) || c.close <= 0
      ) {
        return false;
      }
      if (c.high < c.low) return false;
      if (c.volume !== undefined && (!Number.isFinite(c.volume) || c.volume < 0)) return false;
      return true;
    };

    const hasFiniteRequiredIndicators = (indicatorSnap: any, tf: Timeframe): boolean => {
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
        Number.isFinite(fLast) && fLast > 0 &&
        Number.isFinite(fPrev) && fPrev > 0 &&
        Number.isFinite(sLast) && sLast > 0 &&
        Number.isFinite(sPrev) && sPrev > 0 &&
        Number.isFinite(rsiLast) &&
        Boolean(macdLast) &&
        Number.isFinite(macdLast.macdLine) &&
        Number.isFinite(macdLast.signalLine) &&
        Number.isFinite(macdLast.histogram) &&
        Number.isFinite(atrLast) && atrLast >= 0
      );
    };

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
    if (!Array.isArray(rawCandles) || rawCandles.length === 0 || !Number.isFinite(context.timestamp)) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: [`[TIMEFRAME DATA] Missing or invalid required candle data for timeframe ${targetTimeframe}`],
          signal: null,
          strategyConfig: this.config,
          targetTimeframe,
        }
      };
    }

    for (let i = 0; i < rawCandles.length; i++) {
      if (!Number.isFinite(getCandleCloseTime(rawCandles[i], targetTimeframe))) {
        return {
          strategyId: this.manifest.id,
          timestamp: context.timestamp,
          confidenceScore: 0,
          hasSignal: false,
          metadata: {
            reasoning: [`[TIMEFRAME DATA] Invalid candle timestamp in ${targetTimeframe} series`],
            signal: null,
            strategyConfig: this.config,
            targetTimeframe,
          }
        };
      }
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

    // Strict OHLC validation across the entire closed candle series before any indicator calculation
    if (closedCandlesAtRef.some(c => !isValidOhlcCandle(c))) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: [`[TIMEFRAME DATA] Invalid OHLC candle data detected in ${targetTimeframe} series`],
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
    if (!hasFiniteRequiredIndicators(currentIndicatorSnapshot, targetTimeframe)) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: [`[INDICATOR DATA] Non-finite or unavailable required indicator values on ${targetTimeframe}`],
          signal: null,
          indicatorSnapshot: currentIndicatorSnapshot,
          strategyConfig: this.config,
          targetTimeframe,
        }
      };
    }
    const currentConditionResult = this.conditionEngine.evaluate(currentIndicatorSnapshot);
    const currentConfidenceScore = this.confidenceEngine.evaluate(currentConditionResult);
    if (
      !Number.isFinite(currentConfidenceScore?.overallScore) ||
      !Number.isFinite(currentConfidenceScore?.timeframes?.[targetTimeframe]?.score)
    ) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: [`[CONFIDENCE DATA] Non-finite confidence score evaluated on ${targetTimeframe}`],
          signal: null,
          indicatorSnapshot: currentIndicatorSnapshot,
          conditionResult: currentConditionResult,
          strategyConfig: this.config,
          targetTimeframe,
        }
      };
    }

    // Previous technical evaluation
    let previousIndicatorSnapshot: any = null;
    let previousConditionResult: any = null;
    let previousConfidenceScore: any = null;

    const hasValidPreviousData = Boolean(previousCandlesRecord[targetTimeframe] && previousCandlesRecord[targetTimeframe]!.length >= MIN_CLOSED_CANDLES);

    if (hasValidPreviousData) {
      previousIndicatorSnapshot = this.indicatorEngine.evaluate(snapshotPrevious);
      if (hasFiniteRequiredIndicators(previousIndicatorSnapshot, targetTimeframe)) {
        previousConditionResult = this.conditionEngine.evaluate(previousIndicatorSnapshot);
        previousConfidenceScore = this.confidenceEngine.evaluate(previousConditionResult);
      }
    }

    // 4. Pure Market Alignment Helper (Authoritative on targetTimeframe Trigger)
    const evaluateMarketAlignment = (
      indicatorSnap: any,
      conditionRes: ConditionResult,
      confidenceSc: ConfidenceScore,
      entryCandles: NormalizedCandle[]
    ): { isAlignedBuy: boolean; isAlignedSell: boolean } => {
      if (
        !hasFiniteRequiredIndicators(indicatorSnap, targetTimeframe) ||
        !Number.isFinite(confidenceSc?.overallScore) ||
        !Number.isFinite(confidenceSc?.timeframes?.[targetTimeframe]?.score)
      ) {
        return { isAlignedBuy: false, isAlignedSell: false };
      }

      // Check targetTimeframe SignalEngine trigger with nominal risk (pure market evaluation)
      const lastClose = entryCandles[entryCandles.length - 1]?.close;
      if (!Number.isFinite(lastClose) || lastClose <= 0) {
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

      const tfTrend = conditionRes.timeframes[targetTimeframe]?.trend;
      const hasBullishTrend = Boolean(
        tfTrend &&
        tfTrend.priceAboveEMA === true &&
        (tfTrend.trendDirection === 'UP' || tfTrend.emaCrossoverState === 'BULLISH')
      );
      const hasBearishTrend = Boolean(
        tfTrend &&
        tfTrend.priceAboveEMA === false &&
        (tfTrend.trendDirection === 'DOWN' || tfTrend.emaCrossoverState === 'BEARISH')
      );

      const hasBuyTrigger = triggerSignal?.type === SignalType.BUY && hasBullishTrend;
      const hasSellTrigger = triggerSignal?.type === SignalType.SELL && hasBearishTrend;

      return {
        isAlignedBuy: hasBuyTrigger,
        isAlignedSell: hasSellTrigger,
      };
    };

    // Evaluate market alignment at T and T_previous
    const currentAlignment = evaluateMarketAlignment(
      currentIndicatorSnapshot,
      currentConditionResult,
      currentConfidenceScore,
      currentCandlesRecord[targetTimeframe]!
    );

    let previousAlignment = { isAlignedBuy: false, isAlignedSell: false };
    if (
      hasValidPreviousData &&
      previousIndicatorSnapshot &&
      previousConditionResult &&
      previousConfidenceScore &&
      Number.isFinite(previousConfidenceScore.overallScore) &&
      Number.isFinite(previousConfidenceScore?.timeframes?.[targetTimeframe]?.score)
    ) {
      previousAlignment = evaluateMarketAlignment(
        previousIndicatorSnapshot,
        previousConditionResult,
        previousConfidenceScore,
        previousCandlesRecord[targetTimeframe]!
      );
    }

    const stateKey = `${context.marketSnapshot.symbol}:${targetTimeframe}`;

    // Edge transition: emit only when transitioning from NOT ALIGNED to ALIGNED
    const isNewBuyEvent = currentAlignment.isAlignedBuy && !previousAlignment.isAlignedBuy;
    const isNewSellEvent = currentAlignment.isAlignedSell && !previousAlignment.isAlignedSell;

    // Edge transition recovery: check if previous bar at T_previous had a rejected edge event
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

    if (pendingRejected && !isRecoveredBuyEvent && !isRecoveredSellEvent) {
      // Pending rejected edge event is stale or alignment broke
      this.rejectedEdgeEvents.delete(stateKey);
    }

    const isEdgeBuy = isNewBuyEvent || isRecoveredBuyEvent;
    const isEdgeSell = isNewSellEvent || isRecoveredSellEvent;

    // 5. Evaluate Current Real Risk Gates
    const entryCandles = currentCandlesRecord[targetTimeframe]!;
    const latestCandleClose = entryCandles[entryCandles.length - 1]?.close;
    const currentPrice = (Number.isFinite(latestCandleClose) && latestCandleClose > 0)
      ? latestCandleClose
      : (Number.isFinite(context.marketSnapshot.currentPrice) ? context.marketSnapshot.currentPrice : 0);

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      if (isEdgeBuy) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.BUY });
      } else if (isEdgeSell) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.SELL });
      }
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ['Invalid current price (zero or negative)'], targetTimeframe }
      };
    }

    if (!context.accountBalance || context.accountBalance <= 0) {
      if (isEdgeBuy) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.BUY });
      } else if (isEdgeSell) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.SELL });
      }
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ['Account balance not available — cannot calculate position size'], targetTimeframe }
      };
    }

    // ATR risk calculation strictly on targetTimeframe ATR
    const tfIndicators = currentIndicatorSnapshot.timeframes[targetTimeframe];
    const atrArray = tfIndicators?.atr[this.config.conditionConfig.atrPeriod];
    const currentAtr = (atrArray && atrArray.length > 0) ? atrArray[atrArray.length - 1] : NaN;

    if (!Number.isFinite(currentAtr) || currentAtr <= 0) {
      if (isEdgeBuy) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.BUY });
      } else if (isEdgeSell) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.SELL });
      }
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: ['ATR is zero or unavailable — cannot calculate risk parameters'],
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
        reasoning.push(`[${tfUpper} EDGE RECOVERY] Recovered BUY event: ${targetTimeframe} trigger recovered after transient risk rejection on previous bar.`);
      } else {
        reasoning.push(`[${tfUpper} EDGE EVENT] New BUY event: ${targetTimeframe} trigger transitioned from NOT ALIGNED to ALIGNED.`);
      }
    } else if (isEdgeSell && activeSignal?.type === SignalType.SELL) {
      this.rejectedEdgeEvents.delete(stateKey);
      if (isRecoveredSellEvent) {
        reasoning.push(`[${tfUpper} EDGE RECOVERY] Recovered SELL event: ${targetTimeframe} trigger recovered after transient risk rejection on previous bar.`);
      } else {
        reasoning.push(`[${tfUpper} EDGE EVENT] New SELL event: ${targetTimeframe} trigger transitioned from NOT ALIGNED to ALIGNED.`);
      }
    } else {
      // If an edge transition occurred or was recovering, but activeSignal was rejected by risk/validation:
      if (isEdgeBuy && currentAlignment.isAlignedBuy) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.BUY });
      } else if (isEdgeSell && currentAlignment.isAlignedSell) {
        this.rejectedEdgeEvents.set(stateKey, { timestamp: T, direction: SignalType.SELL });
      } else if (!currentAlignment.isAlignedBuy && !currentAlignment.isAlignedSell) {
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
      reasoning.push('Short signal suppressed: strategy is long-only');
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
