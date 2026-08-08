import { EngineStatusDTO } from './EngineStatusDTO';
import { MarketAnalysisDTO, IndicatorSummary, ConditionSummary } from './MarketAnalysisDTO';
import { SignalDTO } from './SignalDTO';
import { EvaluationResult } from '../../engine/dto/EvaluationResult';
import { StrategyManifest } from '../../engine/strategies/StrategyManifest';
import { MarketSnapshot } from '../../engine/market-data/MarketSnapshot';
import { TimeframeIndicators } from '../../engine/indicator/IndicatorTypes';

export interface AnalysisDiagnosticsDTO {
  isLive: boolean;
  timestamp: number;
  evaluationDurationMs?: number;
}

export interface AnalysisSnapshotDto {
  symbol: string;
  strategy: string;
  price: number;
  change24h: number;
  volume: number;
  high24h: number;
  low24h: number;
  engineStatus: EngineStatusDTO;
  marketAnalysis: MarketAnalysisDTO;
  tradingSignal: SignalDTO;
  diagnostics: AnalysisDiagnosticsDTO;
  // Legacy root fields for backward compatibility
  indicators: Record<string, any>;
  signals: Record<string, any>;
  checkpoints: Array<{ name: string; status: string }>;
  progress: number;
  conditionsMet: string[];
  opportunity: Record<string, any> | null;
  timestamp: string;
}

/**
 * Pure, stateless serialization boundary class that transforms backend engine domain models
 * (EvaluationResult, StrategyManifest, MarketSnapshot) into transport DTOs.
 * 
 * MUST NEVER execute indicator calculations, strategy rule evaluation, confidence scoring, or risk checks.
 */
export class AnalysisSnapshotMapper {
  private constructor() {} // Static utility class

  public static map(
    result: EvaluationResult,
    manifest: StrategyManifest,
    snapshot: MarketSnapshot,
    engineState: string = 'ACTIVE',
    isLive: boolean = false
  ): AnalysisSnapshotDto {
    const indicators = this.mapIndicators(result);
    const checkpoints = this.mapCheckpoints(result);
    const signal = this.mapSignal(result, manifest);

    const priceChangePercent24h = snapshot.metadata?.priceChangePercent24h ?? 0;
    const highPrice24h = snapshot.metadata?.highPrice24h ?? snapshot.currentPrice;
    const lowPrice24h = snapshot.metadata?.lowPrice24h ?? snapshot.currentPrice;
    const volume = snapshot.volume24h || snapshot.quoteVolume24h || 0;

    const engineStatus: EngineStatusDTO = {
      state: engineState,
      activeStrategy: manifest.id,
      lastEvaluationTimestamp: result.timestamp,
      nextEvaluationTime: null,
      health: engineState === 'ERROR' ? 'ERROR' : 'OK',
    };

    const marketAnalysis: MarketAnalysisDTO = {
      symbol: snapshot.symbol,
      timeframeStatus: 'ALIGNED',
      indicatorSummary: indicators,
      conditionSummary: checkpoints,
      confidenceScore: result.confidenceScore,
      confidenceExplanation: result.metadata?.reasoning || [],
    };

    const legacyIndicators: Record<string, any> = {
      rsi: this.extractRsiValue(result) ?? 50.0,
      macd: this.extractMacdValue(result) ?? 0.0,
      macdSignal: 0.0,
      ema20: this.extractEmaValue(result, 20) ?? this.extractEmaValue(result, 9) ?? null,
      ema50: this.extractEmaValue(result, 50) ?? this.extractEmaValue(result, 21) ?? null,
      sma200: this.extractSmaValue(result, 200) ?? null,
      atr: this.extractAtrValue(result) ?? 0.0,
    };

    const legacySignals: Record<string, any> = {
      trend: priceChangePercent24h > 0 ? 'BULLISH' : priceChangePercent24h < 0 ? 'BEARISH' : 'NEUTRAL',
      strength: Math.abs(priceChangePercent24h) > 2 ? 'STRONG' : Math.abs(priceChangePercent24h) > 0.5 ? 'MODERATE' : 'WEAK',
      recommendation: signal.type,
      confidence: result.confidenceScore,
    };

    const legacyCheckpoints = checkpoints.map((c) => ({
      name: c.name,
      status: c.status,
    }));

    const conditionsMet = checkpoints.filter((c) => c.status === 'PASSED').map((c) => c.name);

    let opportunity: Record<string, any> | null = null;
    if (result.hasSignal && signal.type !== 'HOLD') {
      opportunity = {
        symbol: snapshot.symbol,
        entryPrice: signal.signalPrice ?? snapshot.currentPrice,
        stopLoss: signal.stopLoss ?? 0,
        takeProfit: signal.takeProfit ?? 0,
        estimatedPnl: 0,
        positionSize: 100,
        side: signal.entryContext || 'BUY',
      };
    }

    return {
      symbol: snapshot.symbol,
      strategy: manifest.id,
      price: snapshot.currentPrice,
      change24h: priceChangePercent24h,
      volume,
      high24h: highPrice24h,
      low24h: lowPrice24h,
      engineStatus,
      marketAnalysis,
      tradingSignal: signal,
      diagnostics: {
        isLive,
        timestamp: result.timestamp,
      },
      indicators: legacyIndicators,
      signals: legacySignals,
      checkpoints: legacyCheckpoints,
      progress: result.confidenceScore,
      conditionsMet,
      opportunity,
      timestamp: new Date(result?.timestamp || Date.now()).toISOString(),
    };
  }

  private static mapIndicators(result: EvaluationResult): IndicatorSummary[] {
    const summaries: IndicatorSummary[] = [];
    const indSnapshot = result.metadata?.indicatorSnapshot;

    if (indSnapshot && indSnapshot.timeframes) {
      for (const [tf, tfIndicators] of Object.entries(indSnapshot.timeframes as Record<string, TimeframeIndicators>)) {
        if (!tfIndicators) continue;

        if (tfIndicators.rsi) {
          for (const [period, series] of Object.entries(tfIndicators.rsi)) {
            const val = series?.slice(-1)[0];
            if (val !== undefined && val !== null && !isNaN(val)) {
              summaries.push({
                name: `RSI (${period}) [${tf}]`,
                value: val.toFixed(1),
                signal: val > 55 ? 'BULLISH' : val < 45 ? 'BEARISH' : 'NEUTRAL',
              });
            }
          }
        }

        if (tfIndicators.ema) {
          for (const [period, series] of Object.entries(tfIndicators.ema)) {
            const val = series?.slice(-1)[0];
            if (val !== undefined && val !== null && !isNaN(val)) {
              summaries.push({
                name: `EMA (${period}) [${tf}]`,
                value: `$${val.toFixed(2)}`,
                signal: 'NEUTRAL',
              });
            }
          }
        }

        if (tfIndicators.sma) {
          for (const [period, series] of Object.entries(tfIndicators.sma)) {
            const val = series?.slice(-1)[0];
            if (val !== undefined && val !== null && !isNaN(val)) {
              summaries.push({
                name: `SMA (${period}) [${tf}]`,
                value: `$${val.toFixed(2)}`,
                signal: 'NEUTRAL',
              });
            }
          }
        }

        if (tfIndicators.atr) {
          for (const [period, series] of Object.entries(tfIndicators.atr)) {
            const val = series?.slice(-1)[0];
            if (val !== undefined && val !== null && !isNaN(val)) {
              summaries.push({
                name: `ATR (${period}) [${tf}]`,
                value: val.toFixed(2),
                signal: 'NEUTRAL',
              });
            }
          }
        }
      }
    }

    if (summaries.length === 0 && result.metadata?.indicators) {
      for (const [key, val] of Object.entries(result.metadata.indicators)) {
        if (typeof val === 'number') {
          summaries.push({
            name: key.toUpperCase(),
            value: val.toFixed(2),
            signal: 'NEUTRAL',
          });
        }
      }
    }

    if (summaries.length === 0) {
      summaries.push({
        name: 'Data Status',
        value: 'Insufficient',
        signal: 'NEUTRAL',
      });
    }

    return summaries;
  }

  private static mapCheckpoints(result: EvaluationResult): ConditionSummary[] {
    const summaries: ConditionSummary[] = [];

    if (result.metadata?.conditionResult && result.metadata.conditionResult.timeframes) {
      let chkId = 1;
      for (const [tf, tfResult] of Object.entries(result.metadata.conditionResult.timeframes)) {
        const res = tfResult as any;
        if (res.trend) {
          summaries.push({
            id: `chk_${chkId++}`,
            name: `Trend Alignment (${tf})`,
            currentValue: res.trend.reasoning?.[0] || (res.trend.passed ? 'Aligned' : 'Divergent'),
            targetValue: 'Bullish Alignment',
            status: res.trend.passed ? 'PASSED' : 'FAILED',
          });
        }
        if (res.momentum) {
          summaries.push({
            id: `chk_${chkId++}`,
            name: `Momentum Filter (${tf})`,
            currentValue: res.momentum.reasoning?.[0] || (res.momentum.passed ? 'Strong' : 'Weak'),
            targetValue: 'RSI Momentum',
            status: res.momentum.passed ? 'PASSED' : 'FAILED',
          });
        }
        if (res.volatility) {
          summaries.push({
            id: `chk_${chkId++}`,
            name: `Volatility Range (${tf})`,
            currentValue: res.volatility.reasoning?.[0] || (res.volatility.passed ? 'Normal' : 'Extreme'),
            targetValue: 'ATR Buffer',
            status: res.volatility.passed ? 'PASSED' : 'FAILED',
          });
        }
        if (res.volume) {
          summaries.push({
            id: `chk_${chkId++}`,
            name: `Volume Filter (${tf})`,
            currentValue: res.volume.reasoning?.[0] || (res.volume.passed ? 'High' : 'Low'),
            targetValue: 'Volume Expansion',
            status: res.volume.passed ? 'PASSED' : 'FAILED',
          });
        }
      }
    }

    if (summaries.length === 0 && result.metadata?.reasoning && Array.isArray(result.metadata.reasoning)) {
      result.metadata.reasoning.forEach((reason: string, idx: number) => {
        summaries.push({
          id: `chk_${idx + 1}`,
          name: reason,
          currentValue: 'PASSED',
          targetValue: 'PASSED',
          status: 'PASSED',
        });
      });
    }

    return summaries;
  }

  private static mapSignal(result: EvaluationResult, manifest: StrategyManifest): SignalDTO {
    const sig = result.metadata?.signal;
    const type = result.hasSignal ? (sig?.type || 'BUY') : 'HOLD';

    const riskClassification = (
      sig?.riskAssessment?.riskClassification ||
      (result.metadata as any)?.riskAssessment?.riskClassification ||
      manifest.riskProfile?.toUpperCase() ||
      'LOW'
    );

    return {
      type: type as 'BUY' | 'SELL' | 'HOLD',
      entryContext: sig?.side || sig?.timeframe || 'LONG',
      signalPrice: sig?.currentPrice ?? sig?.signalPrice ?? sig?.targetEntryPrice ?? null,
      targetEntryPrice: sig?.targetEntryPrice ?? sig?.currentPrice ?? null,
      stopLoss: sig?.stopLoss ?? null,
      takeProfit: sig?.takeProfit ?? null,
      riskClassification,
      reasoning: result.metadata?.reasoning || [],
    };
  }

  private static extractRsiValue(result: EvaluationResult): number | null {
    const tfData = result.metadata?.indicatorSnapshot?.timeframes as Record<string, TimeframeIndicators> | undefined;
    if (tfData) {
      for (const tfIndicators of Object.values(tfData)) {
        if (tfIndicators?.rsi) {
          for (const series of Object.values(tfIndicators.rsi)) {
            const val = series?.slice(-1)[0];
            if (val !== undefined && val !== null && !isNaN(val)) return val;
          }
        }
      }
    }
    return null;
  }

  private static extractMacdValue(result: EvaluationResult): number | null {
    const tfData = result.metadata?.indicatorSnapshot?.timeframes as Record<string, TimeframeIndicators> | undefined;
    if (tfData) {
      for (const tfIndicators of Object.values(tfData)) {
        if (tfIndicators?.macd) {
          for (const series of Object.values(tfIndicators.macd)) {
            const val = series?.slice(-1)[0]?.macdLine;
            if (val !== undefined && val !== null && !isNaN(val)) return val;
          }
        }
      }
    }
    return null;
  }

  private static extractEmaValue(result: EvaluationResult, period: number): number | null {
    const tfData = result.metadata?.indicatorSnapshot?.timeframes as Record<string, TimeframeIndicators> | undefined;
    if (tfData) {
      for (const tfIndicators of Object.values(tfData)) {
        if (tfIndicators?.ema?.[period]) {
          const series = tfIndicators.ema[period];
          const val = series?.slice(-1)[0];
          if (val !== undefined && val !== null && !isNaN(val)) return val;
        }
      }
    }
    return null;
  }

  private static extractSmaValue(result: EvaluationResult, period: number): number | null {
    const tfData = result.metadata?.indicatorSnapshot?.timeframes as Record<string, TimeframeIndicators> | undefined;
    if (tfData) {
      for (const tfIndicators of Object.values(tfData)) {
        if (tfIndicators?.sma?.[period]) {
          const series = tfIndicators.sma[period];
          const val = series?.slice(-1)[0];
          if (val !== undefined && val !== null && !isNaN(val)) return val;
        }
      }
    }
    return null;
  }

  private static extractAtrValue(result: EvaluationResult): number | null {
    const tfData = result.metadata?.indicatorSnapshot?.timeframes as Record<string, TimeframeIndicators> | undefined;
    if (tfData) {
      for (const tfIndicators of Object.values(tfData)) {
        if (tfIndicators?.atr) {
          for (const series of Object.values(tfIndicators.atr)) {
            const val = series?.slice(-1)[0];
            if (val !== undefined && val !== null && !isNaN(val)) return val;
          }
        }
      }
    }
    return null;
  }
}
