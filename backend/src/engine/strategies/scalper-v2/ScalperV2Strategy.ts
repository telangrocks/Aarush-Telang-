import { IStrategy } from '../../interfaces/IStrategy';
import { StrategyContext } from '../../context/StrategyContext';
import { EvaluationResult } from '../../dto/EvaluationResult';
import { ScalperV2Config, DEFAULT_SCALPER_CONFIG } from './ScalperV2Config';

import { IndicatorEngine } from '../../indicator/IndicatorEngine';
import { ConditionEngine } from '../../condition/ConditionEngine';
import { ConfidenceEngine } from '../../confidence/ConfidenceEngine';
import { RiskEngine, RiskContext } from '../../risk';
import { SignalEngine, SignalContext, SignalType, TradingSignal } from '../../signal';

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

  public evaluate(context: Readonly<StrategyContext>, targetTimeframe: Timeframe): EvaluationResult {
    const MIN_CLOSED_CANDLES = 35;

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

    // 1. Fail-Closed Validation & Reference Time Establishment
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

    // Build Closed-Candle Projections for T across all available timeframes
    const currentCandlesRecord: Partial<Record<Timeframe, NormalizedCandle[]>> = {
      [targetTimeframe]: closedCandlesAtRef,
    };

    if (context.marketSnapshot?.candles) {
      for (const [tfKey, rawTfCandles] of Object.entries(context.marketSnapshot.candles)) {
        const tf = tfKey as Timeframe;
        if (tf === targetTimeframe) continue;
        if (Array.isArray(rawTfCandles)) {
          const closedTf = rawTfCandles.filter(c => getCandleCloseTime(c, tf) <= T);
          if (closedTf.length >= MIN_CLOSED_CANDLES) {
            currentCandlesRecord[tf] = closedTf;
          }
        }
      }
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

    const candles = currentCandlesRecord[targetTimeframe] || [];

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
        metadata: { reasoning: ['Invalid current price (zero or negative)'], targetTimeframe }
      };
    }

    // Guard against accountBalance <= 0
    if (!context.accountBalance || context.accountBalance <= 0) {
      return {
        strategyId: this.manifest.id,
        timestamp: context.timestamp,
        confidenceScore: 0,
        hasSignal: false,
        metadata: { reasoning: ['Account balance not available — cannot calculate position size'], targetTimeframe }
      };
    }
    
    // Risk calculations strictly preserved on targetTimeframe ATR
    const tfIndicators = indicatorSnapshot.timeframes[targetTimeframe];
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
          conditionResult,
          targetTimeframe,
        }
      };
    }

    // 4. Risk (strictly targetTimeframe ATR)
    const riskContext: RiskContext = {
      timestamp: T,
      currentPrice,
      currentAtr,
      accountBalance: context.accountBalance
    };
    const riskAssessment = this.riskEngine.evaluate(riskContext);

    // 5. Signal: 5m and 15m identify short-term entry opportunities; 1h and 4h confirm broader market direction
    const MACRO_CONFIRMATION_TIMEFRAMES: Timeframe[] = ['1h', '4h'];
    const isEntryTimeframe = targetTimeframe === '5m' || targetTimeframe === '15m';

    let activeSignal: TradingSignal | null = null;
    const reasoning: string[] = [];

    const availableMacroTimeframes: Timeframe[] = [];
    const confirmingTimeframes: Timeframe[] = [];
    const conflictingTimeframes: Timeframe[] = [];
    const neutralTimeframes: Timeframe[] = [];

    if (!isEntryTimeframe) {
      reasoning.push(`[MTF ROLE] Timeframe ${targetTimeframe} is a macro confirmation timeframe; entry signals are restricted to 5m and 15m`);
    } else {
      const signalContext: SignalContext = {
        symbol: context.marketSnapshot.symbol,
        timeframe: targetTimeframe,
        currentPrice
      };

      const tradingSignal = this.signalEngine.evaluate(
        signalContext,
        conditionResult,
        confidenceScore,
        riskAssessment
      );

      if (!tradingSignal) {
        reasoning.push(`No qualified signal generated on ${targetTimeframe} trigger`);
      } else {
        reasoning.push(...tradingSignal.reasoning);
        const candidateType = tradingSignal.type;

        // Evaluate Higher-Timeframe Confirmation (1h and 4h) using existing strategy calculations
        for (const mtf of MACRO_CONFIRMATION_TIMEFRAMES) {
          const tfCond = conditionResult.timeframes[mtf];
          if (!tfCond) {
            continue; // Timeframe not present or insufficient closed candles
          }
          availableMacroTimeframes.push(mtf);

          const isUp = tfCond.trend.trendDirection === 'UP' || tfCond.trend.emaCrossoverState === 'BULLISH';
          const isDown = tfCond.trend.trendDirection === 'DOWN' || tfCond.trend.emaCrossoverState === 'BEARISH';

          let mtfDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
          if (isUp && !isDown) {
            mtfDirection = 'BULLISH';
          } else if (isDown && !isUp) {
            mtfDirection = 'BEARISH';
          }

          if (candidateType === SignalType.BUY) {
            if (mtfDirection === 'BEARISH') {
              conflictingTimeframes.push(mtf);
            } else if (mtfDirection === 'BULLISH') {
              confirmingTimeframes.push(mtf);
            } else {
              neutralTimeframes.push(mtf);
            }
          } else if (candidateType === SignalType.SELL) {
            if (mtfDirection === 'BULLISH') {
              conflictingTimeframes.push(mtf);
            } else if (mtfDirection === 'BEARISH') {
              confirmingTimeframes.push(mtf);
            } else {
              neutralTimeframes.push(mtf);
            }
          }
        }

        // Fail-closed & Non-perfect Agreement arbitration
        if (availableMacroTimeframes.length === 0) {
          reasoning.push(`[MTF CONFIRMATION] ${candidateType} rejected: Missing required higher-timeframe data (1h, 4h) for confirmation`);
        } else if (conflictingTimeframes.length > 0) {
          reasoning.push(`[MTF CONFIRMATION] ${candidateType} rejected: Conflicted by higher timeframe (${conflictingTimeframes.join(', ')}) direction`);
        } else if (confirmingTimeframes.length === 0) {
          reasoning.push(`[MTF CONFIRMATION] ${candidateType} rejected: Lacks higher-timeframe confirmation (${availableMacroTimeframes.join(', ')} neutral)`);
        } else {
          activeSignal = tradingSignal;
          reasoning.push(`[MTF CONFIRMATION] ${candidateType} confirmed by broader market direction (${confirmingTimeframes.join(', ')})`);
        }
      }
    }

    if (activeSignal && !this.manifest.supportsShort && activeSignal.type === SignalType.SELL) {
      activeSignal = null;
      reasoning.push('Short signal suppressed: strategy is long-only');
    }

    const hasSignal = activeSignal !== null && (activeSignal.type === SignalType.BUY || activeSignal.type === SignalType.SELL);

    const primaryTfConfidence = confidenceScore.timeframes[targetTimeframe];
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
        indicatorSnapshot,
        conditionResult,
        confidenceScore,
        strategyConfig: this.config,
        targetTimeframe,
        mtfConfirmation: {
          isEntryTimeframe,
          availableMacroTimeframes,
          confirmingTimeframes,
          conflictingTimeframes,
          neutralTimeframes,
        }
      }
    };
  }
}
