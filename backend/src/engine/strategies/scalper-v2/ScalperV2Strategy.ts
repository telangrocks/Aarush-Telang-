import { IStrategy } from '../../interfaces/IStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { EvaluationResult } from '../../dto/EvaluationResult';
import { ScalperV2Config, DEFAULT_SCALPER_CONFIG } from './ScalperV2Config';

import { IndicatorEngine } from '../../indicator/IndicatorEngine';
import { ConditionEngine } from '../../condition/ConditionEngine';
import { ConfidenceEngine } from '../../confidence/ConfidenceEngine';
import { RiskEngine, RiskContext } from '../../risk';
import { SignalEngine, SignalContext, SignalType } from '../../signal';

import { StrategyManifest } from '../StrategyManifest';
import { CandleValidator } from '../../../infrastructure/exchange/CandleValidator';
import { MarketSnapshot, NormalizedCandle } from '../../market-data/MarketSnapshot';
import { Timeframe } from '../../market-data/Timeframe';

/**
 * Derives the candle close timestamp in milliseconds.
 * In Bybit REST / standard exchange models, kline timestamp is open time.
 * If closeTime is not explicitly populated, closeTime = openTime + timeframeMs.
 */
function getCandleCloseTime(candle: NormalizedCandle, tf: string): number {
  if (typeof (candle as any).closeTime === 'number' && (candle as any).closeTime > 0) {
    return (candle as any).closeTime;
  }
  const tfMs = CandleValidator.timeframeToMs(tf);
  if (typeof candle.openTime === 'number' && candle.openTime > 0) {
    return candle.openTime + tfMs;
  }
  if (typeof candle.timestamp === 'number' && candle.timestamp > 0) {
    return candle.timestamp + tfMs;
  }
  return 0;
}

export class ScalperV2Strategy implements IStrategy {
  public readonly manifest: StrategyManifest = {
    id: 'ScalperV2',
    displayName: 'Scalper V2',
    description: 'A high-frequency trend-following scalper leveraging fast EMAs and ATR-based risk management.',
    version: '2.0.0',
    category: 'Scalping',
    riskProfile: 'High',
    supportedMarkets: ['CRYPTO'],
    supportedTimeframes: ['5m', '15m', '1h', '4h'],
    minimumCandles: 200,
    defaultConfiguration: DEFAULT_SCALPER_CONFIG,
    supportsLong: true,
    supportsShort: true,
    supportsPaperTrading: true,
    supportsLiveTrading: true,
    status: 'ACTIVE',
    author: 'System',
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

  constructor(private config: ScalperV2Config = DEFAULT_SCALPER_CONFIG) {
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
    // 15m → Intermediate Momentum
    // 5m  → Actual Scalping Entry Trigger
    const ENTRY_TIMEFRAME = '5m' as const;
    const HIGHER_TIMEFRAMES = ['15m', '1h', '4h'] as const;
    const ALL_REQUIRED_TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;
    const MIN_CLOSED_CANDLES = 35;

    // Fail-Closed Validation & Reference Time Establishment
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

    // Build Closed-Candle Projections for T across all 4 required timeframes
    const currentCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {};

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
    }

    // Technical Indicator & Condition Evaluations on Independent In-Memory Projection
    const snapshotCurrent: MarketSnapshot = {
      ...context.marketSnapshot,
      timestamp: T,
      candles: currentCandlesRecord as any,
    };

    // 1. Indicators
    const indicatorSnapshot = this.indicatorEngine.evaluate(snapshotCurrent);

    // 2. Conditions
    const conditionResult = this.conditionEngine.evaluate(indicatorSnapshot);

    // 3. Confidence
    const confidenceScore = this.confidenceEngine.evaluate(conditionResult);

    const candles = currentCandlesRecord[ENTRY_TIMEFRAME] || [];

    // Guard against currentPrice <= 0
    const latestCandleClose = candles[candles.length - 1]?.close || 0;
    const currentPrice = (latestCandleClose > 0) 
      ? latestCandleClose 
      : context.marketSnapshot.currentPrice || 0;

    if (currentPrice <= 0) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ['Invalid current price (zero or negative)'] }
      };
    }

    // Guard against accountBalance <= 0
    if (!context.accountBalance || context.accountBalance <= 0) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ['Account balance not available — cannot calculate position size'] }
      };
    }
    
    // Risk calculations strictly preserved on 5m ATR
    const tfIndicators = indicatorSnapshot.timeframes[ENTRY_TIMEFRAME];
    const atrArray = tfIndicators?.atr[this.config.conditionConfig.atrPeriod];
    const currentAtr = (atrArray && atrArray.length > 0) ? atrArray[atrArray.length - 1] : 0;

    if (!currentAtr || currentAtr <= 0) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: {
          reasoning: ['ATR is zero or unavailable — cannot calculate risk parameters'],
          signal: null,
          indicatorSnapshot,
          conditionResult
        }
      };
    }

    // 4. Risk (strictly 5m ATR)
    const riskContext: RiskContext = {
      timestamp: T,
      currentPrice,
      currentAtr,
      accountBalance: context.accountBalance
    };
    const riskAssessment = this.riskEngine.evaluate(riskContext);

    // 5. Signal: 5m provides the actual entry trigger
    const signalContext: SignalContext = {
      symbol: context.marketSnapshot.symbol,
      timeframe: ENTRY_TIMEFRAME,
      currentPrice
    };

    const tradingSignal = this.signalEngine.evaluate(
      signalContext,
      conditionResult,
      confidenceScore,
      riskAssessment
    );

    let activeSignal = tradingSignal;
    const reasoning = tradingSignal ? [...tradingSignal.reasoning] : ['No qualified signal generated on 5m trigger'];

    // 6. Multi-Timeframe Alignment Gate
    const minThreshold = this.config.signalRules.minConfidenceScore;

    if (activeSignal && (activeSignal.type === SignalType.BUY || activeSignal.type === SignalType.SELL)) {
      const proposedSide = activeSignal.type;
      const tfRoles: Record<string, string> = {
        '4h': '4h Structural Bias',
        '1h': '1h Macro Trend',
        '15m': '15m Intermediate Momentum',
        '5m': '5m Entry Trigger'
      };

      let mtfAligned = true;

      for (const tf of HIGHER_TIMEFRAMES) {
        const tfConf = confidenceScore.timeframes[tf];
        const role = tfRoles[tf];

        if (!tfConf || typeof tfConf.longScore !== 'number' || typeof tfConf.shortScore !== 'number') {
          mtfAligned = false;
          reasoning.push(`[MTF FAIL-CLOSED] ${role} (${tf}) missing explicit directional confidence score.`);
          break;
        }

        if (proposedSide === SignalType.BUY) {
          if (tfConf.shortScore >= minThreshold) {
            mtfAligned = false;
            reasoning.push(`[MTF DISAGREEMENT] ${role} (${tf}) contradicts BUY: ShortScore (${tfConf.shortScore}) >= ${minThreshold}.`);
          } else if (tfConf.longScore < minThreshold) {
            mtfAligned = false;
            reasoning.push(`[MTF NEUTRAL/INSUFFICIENT] ${role} (${tf}) does not support BUY: LongScore (${tfConf.longScore}) < ${minThreshold}.`);
          } else {
            reasoning.push(`[MTF ALIGNED] ${role} (${tf}) supports BUY: LongScore (${tfConf.longScore}) >= ${minThreshold}.`);
          }
        } else if (proposedSide === SignalType.SELL) {
          if (tfConf.longScore >= minThreshold) {
            mtfAligned = false;
            reasoning.push(`[MTF DISAGREEMENT] ${role} (${tf}) contradicts SELL: LongScore (${tfConf.longScore}) >= ${minThreshold}.`);
          } else if (tfConf.shortScore < minThreshold) {
            mtfAligned = false;
            reasoning.push(`[MTF NEUTRAL/INSUFFICIENT] ${role} (${tf}) does not support SELL: ShortScore (${tfConf.shortScore}) < ${minThreshold}.`);
          } else {
            reasoning.push(`[MTF ALIGNED] ${role} (${tf}) supports SELL: ShortScore (${tfConf.shortScore}) >= ${minThreshold}.`);
          }
        }
      }

      if (!mtfAligned) {
        activeSignal = null;
        reasoning.push('[MTF REJECTED] Trade cancelled: Multi-timeframe confluence failed across 4h, 1h, 15m, and 5m.');
      } else {
        reasoning.push(`[MTF CONFIRMED] All four timeframes (4h, 1h, 15m, 5m) actively agree on ${proposedSide}.`);
      }
    }

    if (activeSignal && !this.manifest.supportsShort && activeSignal.type === SignalType.SELL) {
      activeSignal = null;
      reasoning.push('Short signal suppressed: strategy is long-only');
    }

    const hasSignal = activeSignal !== null && (activeSignal.type === SignalType.BUY || activeSignal.type === SignalType.SELL);

    const primaryTfConfidence = confidenceScore.timeframes[ENTRY_TIMEFRAME];
    const directionalConfidence = activeSignal?.type === SignalType.SELL
      ? (primaryTfConfidence?.shortScore ?? confidenceScore.overallShortScore!)
      : activeSignal?.type === SignalType.BUY
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
      }
    };
  }
}
