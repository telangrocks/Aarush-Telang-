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

  constructor(private config: MomentumConfig = DEFAULT_MOMENTUM_CONFIG) {
    this.indicatorEngine = new IndicatorEngine(config.indicatorConfig);
    this.conditionEngine = new ConditionEngine(config.conditionConfig);
    this.confidenceEngine = new ConfidenceEngine(config.confidenceWeights);
    this.riskEngine = new RiskEngine(config.riskParameters);
    this.signalEngine = new SignalEngine(config.signalRules);
  }

  public evaluate(context: Readonly<StrategyContext>): EvaluationResult {
    // Timeframe Architecture:
    // 4h  → Structural Bias
    // 1h  → Macro Trend
    // 15m → Intermediate Momentum & Risk Calculation (ATR 14)
    // 5m  → Micro Entry Trigger
    const ENTRY_TIMEFRAME = '5m' as const;
    const RISK_TIMEFRAME = '15m' as const;
    const ALL_REQUIRED_TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;
    const MIN_CLOSED_CANDLES = 201;

    const TF_ROLES: Record<string, string> = {
      '4h': '4h Structural Bias',
      '1h': '1h Macro Trend',
      '15m': '15m Intermediate Momentum',
      '5m': '5m Entry Trigger'
    };

    // Helper: Derive candle close time deterministically
    const getCandleCloseTime = (c: NormalizedCandle, tf: string): number => {
      return (c as any).closeTime ?? ((c.openTime ?? c.timestamp ?? 0) + CandleValidator.timeframeToMs(tf));
    };

    // 1. Snapshot Evaluation Reference Time (T & T_previous)
    const raw5mCandles = context.marketSnapshot?.candles?.[ENTRY_TIMEFRAME];
    if (!raw5mCandles || raw5mCandles.length === 0) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: [`[MTF DATA] Missing required candle data for timeframe ${ENTRY_TIMEFRAME}`],
          signal: null,
          strategyConfig: this.config,
        }
      };
    }

    // Filter forming 5m candles: only closed candles at or before context.timestamp
    const closed5mAtRef = raw5mCandles.filter(c => getCandleCloseTime(c, ENTRY_TIMEFRAME) <= context.timestamp);
    if (closed5mAtRef.length < MIN_CLOSED_CANDLES) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: [`[MTF DATA] Insufficient closed candle data for timeframe ${ENTRY_TIMEFRAME} (got ${closed5mAtRef.length}, required >= ${MIN_CLOSED_CANDLES})`],
          signal: null,
          strategyConfig: this.config,
        }
      };
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
        return {
          strategyId: this.manifest.id,
          timestamp: context.timestamp,
          confidenceScore: 0,
          hasSignal: false,
          metadata: {
            reasoning: [`[MTF DATA] Missing required candle data for timeframe ${tf}`],
            signal: null,
            strategyConfig: this.config,
          }
        };
      }

      // Filter closed candles at or before T (forming candles strictly excluded)
      const closedAtT = rawTfCandles.filter(c => getCandleCloseTime(c, tf) <= T);
      if (closedAtT.length < MIN_CLOSED_CANDLES) {
        return {
          strategyId: this.manifest.id,
          timestamp: context.timestamp,
          confidenceScore: 0,
          hasSignal: false,
          metadata: {
            reasoning: [`[MTF DATA] Insufficient closed candle data for timeframe ${tf} (got ${closedAtT.length}, required >= ${MIN_CLOSED_CANDLES})`],
            signal: null,
            strategyConfig: this.config,
          }
        };
      }
      currentCandlesRecord[tf] = closedAtT;

      // Filter closed candles at or before T_previous
      const closedAtTPrev = rawTfCandles.filter(c => getCandleCloseTime(c, tf) <= T_previous);
      previousCandlesRecord[tf] = closedAtTPrev;
    }

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
    let hasValidPreviousData = true;

    for (const tf of ALL_REQUIRED_TIMEFRAMES) {
      if (!previousCandlesRecord[tf] || previousCandlesRecord[tf]!.length < MIN_CLOSED_CANDLES) {
        hasValidPreviousData = false;
        break;
      }
    }

    if (hasValidPreviousData) {
      previousIndicatorSnapshot = this.indicatorEngine.evaluate(snapshotPrevious);
      previousConditionResult = this.conditionEngine.evaluate(previousIndicatorSnapshot);
      previousConfidenceScore = this.confidenceEngine.evaluate(previousConditionResult);
    }

    // 4. Pure Market Alignment Helper (Separated from Risk Gates)
    const evaluateMarketAlignment = (
      conditionRes: ConditionResult,
      confidenceSc: ConfidenceScore,
      entryCandles: NormalizedCandle[]
    ): { isAlignedBuy: boolean; isAlignedSell: boolean; tfReasoning: string[] } => {
      const minThreshold = this.config.signalRules.minConfidenceScore;
      const tfReasoning: string[] = [];

      let buyMtf = true;
      let sellMtf = true;

      for (const tf of ALL_REQUIRED_TIMEFRAMES) {
        const tfConf = confidenceSc.timeframes[tf];
        const role = TF_ROLES[tf] || tf;

        if (!tfConf || typeof tfConf.longScore !== 'number' || typeof tfConf.shortScore !== 'number') {
          buyMtf = false;
          sellMtf = false;
          tfReasoning.push(`[MTF FAIL-CLOSED] ${role} (${tf}) missing explicit directional confidence score.`);
          break;
        }

        // BUY Model C check: longScore >= 70 && shortScore < 70
        if (tfConf.longScore >= minThreshold && tfConf.shortScore < minThreshold) {
          tfReasoning.push(`[MTF ALIGNED] ${role} (${tf}) supports BUY: LongScore (${tfConf.longScore}) >= ${minThreshold}.`);
        } else {
          buyMtf = false;
          if (tfConf.shortScore >= minThreshold) {
            tfReasoning.push(`[MTF DISAGREEMENT] ${role} (${tf}) contradicts BUY: ShortScore (${tfConf.shortScore}) >= ${minThreshold}.`);
          } else {
            tfReasoning.push(`[MTF NEUTRAL/INSUFFICIENT] ${role} (${tf}) does not support BUY: LongScore (${tfConf.longScore}) < ${minThreshold}.`);
          }
        }

        // SELL Model C check: shortScore >= 70 && longScore < 70
        if (tfConf.shortScore >= minThreshold && tfConf.longScore < minThreshold) {
          tfReasoning.push(`[MTF ALIGNED] ${role} (${tf}) supports SELL: ShortScore (${tfConf.shortScore}) >= ${minThreshold}.`);
        } else {
          sellMtf = false;
          if (tfConf.longScore >= minThreshold) {
            tfReasoning.push(`[MTF DISAGREEMENT] ${role} (${tf}) contradicts SELL: LongScore (${tfConf.longScore}) >= ${minThreshold}.`);
          } else {
            tfReasoning.push(`[MTF NEUTRAL/INSUFFICIENT] ${role} (${tf}) does not support SELL: ShortScore (${tfConf.shortScore}) < ${minThreshold}.`);
          }
        }
      }

      // Check 5m SignalEngine trigger with nominal risk (pure market evaluation)
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
        timeframe: ENTRY_TIMEFRAME,
        currentPrice: lastClose
      };

      const triggerSignal = this.signalEngine.evaluate(
        evalContext,
        conditionRes,
        confidenceSc,
        nominalRisk
      );

      const has5mBuyTrigger = triggerSignal?.type === SignalType.BUY;
      const has5mSellTrigger = triggerSignal?.type === SignalType.SELL;

      return {
        isAlignedBuy: buyMtf && has5mBuyTrigger,
        isAlignedSell: sellMtf && has5mSellTrigger,
        tfReasoning
      };
    };

    // Evaluate market alignment at T and T_previous
    const currentAlignment = evaluateMarketAlignment(
      currentConditionResult,
      currentConfidenceScore,
      currentCandlesRecord[ENTRY_TIMEFRAME]!
    );

    let previousAlignment = { isAlignedBuy: false, isAlignedSell: false, tfReasoning: [] as string[] };
    if (hasValidPreviousData && previousConditionResult && previousConfidenceScore) {
      previousAlignment = evaluateMarketAlignment(
        previousConditionResult,
        previousConfidenceScore,
        previousCandlesRecord[ENTRY_TIMEFRAME]!
      );
    }

    // Edge transition: emit only when transitioning from NOT ALIGNED to ALIGNED
    const isNewBuyEvent = currentAlignment.isAlignedBuy && !previousAlignment.isAlignedBuy;
    const isNewSellEvent = currentAlignment.isAlignedSell && !previousAlignment.isAlignedSell;

    // 5. Evaluate Current Real Risk Gates
    const entryCandles = currentCandlesRecord[ENTRY_TIMEFRAME]!;
    const latestCandleClose = entryCandles[entryCandles.length - 1]?.close || 0;
    const currentPrice = latestCandleClose > 0 ? latestCandleClose : context.marketSnapshot.currentPrice || 0;

    if (currentPrice <= 0) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ['Invalid current price (zero or negative)'] }
      };
    }

    if (!context.accountBalance || context.accountBalance <= 0) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ['Account balance not available — cannot calculate position size'] }
      };
    }

    // 15m ATR risk calculation strictly preserved for Momentum
    const tfIndicators15m = currentIndicatorSnapshot.timeframes[RISK_TIMEFRAME];
    const atrArray15m = tfIndicators15m?.atr[this.config.conditionConfig.atrPeriod];
    const currentAtr = (atrArray15m && atrArray15m.length > 0) ? atrArray15m[atrArray15m.length - 1] : 0;

    if (!currentAtr || currentAtr <= 0) {
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

    // 6. Generate Trading Signal on 5m Trigger
    const signalContext: SignalContext = {
      symbol: context.marketSnapshot.symbol,
      timeframe: ENTRY_TIMEFRAME,
      currentPrice
    };

    let activeSignal = this.signalEngine.evaluate(
      signalContext,
      currentConditionResult,
      currentConfidenceScore,
      realRiskAssessment
    );

    const reasoning: string[] = activeSignal ? [...activeSignal.reasoning] : ['No qualified signal generated on 5m trigger'];

    // 7. Apply Edge Transition Confluence Gate
    if (isNewBuyEvent && activeSignal?.type === SignalType.BUY) {
      reasoning.push('[MTF EDGE EVENT] New BUY event: 4TF confluence transitioned from NOT ALIGNED to ALIGNED.');
    } else if (isNewSellEvent && activeSignal?.type === SignalType.SELL) {
      reasoning.push('[MTF EDGE EVENT] New SELL event: 4TF confluence transitioned from NOT ALIGNED to ALIGNED.');
    } else {
      if (currentAlignment.isAlignedBuy && previousAlignment.isAlignedBuy) {
        reasoning.push('[MTF CONTINUATION] Trend continuation suppressed: 4TF BUY confluence already active on previous bar.');
      } else if (currentAlignment.isAlignedSell && previousAlignment.isAlignedSell) {
        reasoning.push('[MTF CONTINUATION] Trend continuation suppressed: 4TF SELL confluence already active on previous bar.');
      } else if (!currentAlignment.isAlignedBuy && !currentAlignment.isAlignedSell) {
        reasoning.push(...currentAlignment.tfReasoning);
        reasoning.push('[MTF REJECTED] Trade cancelled: Multi-timeframe confluence failed across 4h, 1h, 15m, and 5m.');
      }
      activeSignal = null;
    }

    if (activeSignal && !this.manifest.supportsShort && activeSignal.type === SignalType.SELL) {
      activeSignal = null;
      reasoning.push('Short signal suppressed: strategy is long-only');
    }

    const hasSignal = activeSignal !== null && (activeSignal.type === SignalType.BUY || activeSignal.type === SignalType.SELL);

    const primaryTfConfidence = currentConfidenceScore.timeframes[ENTRY_TIMEFRAME];
    const directionalConfidence = activeSignal?.type === SignalType.SELL
      ? (primaryTfConfidence?.shortScore ?? currentConfidenceScore.overallShortScore!)
      : activeSignal?.type === SignalType.BUY
      ? (primaryTfConfidence?.longScore ?? currentConfidenceScore.overallLongScore!)
      : (primaryTfConfidence?.score ?? currentConfidenceScore.overallScore);

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
      }
    };
  }
}

