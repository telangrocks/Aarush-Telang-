import { EngineStatusDTO } from './EngineStatusDTO';
import { MarketAnalysisDTO, IndicatorSummary, ConditionSummary, StrategyMetadataDTO, StrategyParameterDTO, FactorContributionDTO } from './MarketAnalysisDTO';
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
  strategyMetadata?: StrategyMetadataDTO;
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
    const indicators = this.mapIndicators(result, manifest);
    const checkpoints = this.mapCheckpoints(result, manifest);
    const signal = this.mapSignal(result, manifest);
    const strategyMetadata = this.mapStrategyMetadata(result, manifest);

    const priceChangePercent24h = snapshot.metadata?.priceChangePercent24h ?? 0;
    const highPrice24h = snapshot.metadata?.highPrice24h ?? snapshot.currentPrice;
    const lowPrice24h = snapshot.metadata?.lowPrice24h ?? snapshot.currentPrice;
    const volume = snapshot.volume24h || snapshot.quoteVolume24h || 0;

    const isPreviewOrInactive = engineState === 'PREVIEW' || engineState === 'INACTIVE' || engineState === 'STOPPED';
    const engineStatus: EngineStatusDTO = {
      state: engineState,
      activeStrategy: isPreviewOrInactive ? null : manifest.id,
      lastEvaluationTimestamp: result.timestamp,
      nextEvaluationTime: null,
      health: engineState === 'ERROR' ? 'ERROR' : 'OK',
    };

    const marketAnalysis: MarketAnalysisDTO = {
      symbol: snapshot.symbol,
      timeframeStatus: 'ALIGNED',
      indicatorSummary: indicators,
      conditionSummary: checkpoints,
      confidenceScore: result.metadata?.confidenceScore?.overallScore ?? result.confidenceScore,
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

    const rawSignal = result.metadata?.signal;
    let opportunity: Record<string, any> | null = null;
    if (result.hasSignal && signal.type !== 'HOLD') {
      const positionSize = rawSignal?.riskAssessment?.positionSizeRecommendation || 0;
      const entryPrice = signal.signalPrice ?? snapshot.currentPrice;
      const takeProfit = signal.takeProfit ?? 0;
      const estimatedPnl = Math.abs(takeProfit - entryPrice) * (entryPrice > 0 ? positionSize / entryPrice : 0);
      
      opportunity = {
        id: crypto.randomUUID(),
        symbol: snapshot.symbol,
        signalPrice: signal.signalPrice || entryPrice,
        targetEntryPrice: signal.targetEntryPrice ?? undefined,
        entryPrice: entryPrice,
        stopLoss: signal.stopLoss ?? 0,
        takeProfit: takeProfit,
        estimatedPnl: estimatedPnl,
        positionSize: positionSize,
        strategy: manifest.id,
        side: signal.entryContext === 'SELL' ? 'SELL' : 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending'
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
      strategyMetadata,
      indicators: legacyIndicators,
      signals: legacySignals,
      checkpoints: legacyCheckpoints,
      progress: result.confidenceScore,
      conditionsMet,
      opportunity,
      timestamp: new Date(result?.timestamp || Date.now()).toISOString(),
    };
  }
  private static mapStrategyMetadata(result: EvaluationResult, manifest: StrategyManifest): StrategyMetadataDTO {
    const config = result.metadata?.strategyConfig || manifest.defaultConfiguration || {};
    const primaryTimeframe = (config.preferredTimeframes?.[0] || manifest.supportedTimeframes?.[0] || '15m') as string;
    const timeframesAnalyzed = (manifest.supportedTimeframes || [primaryTimeframe]) as string[];

    const parameters: StrategyParameterDTO[] = [];
    const riskLevel = manifest.parameters?.find((p: any) => p.key === 'risk_level')?.defaultValue || 'Medium';
    const mode = manifest.parameters?.find((p: any) => p.key === 'mode')?.defaultValue || 'Aggressive';
    parameters.push({ key: 'risk_level', label: 'Risk Level', value: String(riskLevel).toUpperCase() });
    parameters.push({ key: 'mode', label: 'Mode', value: String(mode).toUpperCase() });

    if (config.signalRules?.minConfidenceScore !== undefined) {
      parameters.push({ key: 'min_confidence', label: 'Min Confidence', value: `${config.signalRules.minConfidenceScore}%` });
    }

    if (config.trendFilter?.maxEmaSeparationPercent !== undefined) {
      parameters.push({ key: 'max_ema_sep', label: 'Max EMA Separation', value: `${config.trendFilter.maxEmaSeparationPercent.toFixed(1)}%` });
    }
    if (config.entryRules?.requireTwoStepConfirmation !== undefined) {
      parameters.push({ key: 'two_step_conf', label: 'Two-Step Confirmation', value: config.entryRules.requireTwoStepConfirmation ? 'Enabled' : 'Disabled' });
    }

    if (config.vwapRules?.maxDeviationThresholdPercent !== undefined) {
      parameters.push({ key: 'max_vwap_dev', label: 'Max VWAP Deviation', value: `${config.vwapRules.maxDeviationThresholdPercent.toFixed(1)}%` });
    }
    if (config.vwapRules?.minVolumeMultiplier !== undefined) {
      parameters.push({ key: 'min_vol_mult', label: 'Min Volume Multiplier', value: `${config.vwapRules.minVolumeMultiplier.toFixed(1)}x` });
    }
    if (config.vwapRules?.minSidewaysDisplacementPercent !== undefined) {
      parameters.push({ key: 'min_displacement', label: 'Min Displacement', value: `${config.vwapRules.minSidewaysDisplacementPercent.toFixed(1)}%` });
    }

    const weights = config.confidenceWeights || { trend: 30, momentum: 30, volatility: 20, volume: 20 };
    const confScoreObj = result.metadata?.confidenceScore;
    
    let trendScore = 75;
    let momentumScore = 75;
    let volatilityScore = 75;
    let volumeScore = 75;

    if (confScoreObj?.timeframes) {
      const tfKeys = Object.keys(confScoreObj.timeframes);
      const tfKey = tfKeys.includes(primaryTimeframe) ? primaryTimeframe : tfKeys[0];
      const tfFactors = confScoreObj.timeframes[tfKey]?.factors;
      if (tfFactors) {
        trendScore = tfFactors.trendScore ?? 75;
        momentumScore = tfFactors.momentumScore ?? 75;
        volatilityScore = tfFactors.volatilityScore ?? 75;
        volumeScore = tfFactors.volumeScore ?? 75;
      }
    }

    const getLevel = (score: number) => score >= 80 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW';

    const factorContributions: FactorContributionDTO[] = [
      { factor: 'Trend Alignment', weight: weights.trend ?? 30, score: trendScore, level: getLevel(trendScore) },
      { factor: 'Momentum Filter', weight: weights.momentum ?? 30, score: momentumScore, level: getLevel(momentumScore) },
      { factor: 'Volatility Buffer', weight: weights.volatility ?? 20, score: volatilityScore, level: getLevel(volatilityScore) },
      { factor: 'Volume Confirmation', weight: weights.volume ?? 20, score: volumeScore, level: getLevel(volumeScore) }
    ];

    return {
      strategyId: manifest.id,
      displayName: manifest.displayName || (manifest as any).name || manifest.id,
      primaryTimeframe,
      timeframesAnalyzed,
      category: manifest.category || (manifest as any).classification || 'Trading',
      riskProfile: manifest.riskProfile || 'Medium',
      parameters,
      factorContributions
    };
  }

  private static mapIndicators(result: EvaluationResult, manifest?: StrategyManifest): IndicatorSummary[] {
    const summaries: IndicatorSummary[] = [];

    if (result.metadata?.customIndicators && Array.isArray(result.metadata.customIndicators)) {
      for (const custom of result.metadata.customIndicators) {
        if (custom && custom.name && custom.value !== undefined) {
          summaries.push({
            name: custom.name,
            value: String(custom.value),
            signal: custom.signal || 'NEUTRAL'
          });
        }
      }
    }

    const config = result.metadata?.strategyConfig || manifest?.defaultConfiguration;
    const indConfig = config?.indicatorConfig;
    const conditionConfig = config?.conditionConfig;

    const indSnapshot = result.metadata?.indicatorSnapshot;
    if (indSnapshot && indSnapshot.timeframes) {
      for (const [tf, tfIndicators] of Object.entries(indSnapshot.timeframes as Record<string, TimeframeIndicators>)) {
        if (!tfIndicators) continue;

        if (tfIndicators.rsi) {
          const rsiPeriods = indConfig?.rsiPeriods || Object.keys(tfIndicators.rsi).map(Number);
          for (const period of rsiPeriods) {
            const series = tfIndicators.rsi[period];
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
          const emaPeriods = indConfig?.emaPeriods || Object.keys(tfIndicators.ema).map(Number);
          for (const period of emaPeriods) {
            const series = tfIndicators.ema[period];
            const val = series?.slice(-1)[0];
            if (val !== undefined && val !== null && !isNaN(val)) {
              const isFast = conditionConfig?.emaFastPeriod === period;
              const isSlow = conditionConfig?.emaSlowPeriod === period;
              const label = isFast ? `Fast EMA (${period}) [${tf}]` : isSlow ? `Slow EMA (${period}) [${tf}]` : `EMA (${period}) [${tf}]`;
              summaries.push({
                name: label,
                value: `$${val.toFixed(2)}`,
                signal: 'NEUTRAL',
              });
            }
          }
        }

        if (tfIndicators.macd) {
          const macdKeys = indConfig?.macdParams?.map((p: any) => `${p.fast},${p.slow},${p.signal}`) || Object.keys(tfIndicators.macd);
          for (const key of macdKeys) {
            const series = tfIndicators.macd[key];
            const lastMacd = series?.slice(-1)[0];
            if (lastMacd && !isNaN(lastMacd.macdLine)) {
              const isBullish = lastMacd.histogram > 0;
              const isBearish = lastMacd.histogram < 0;
              summaries.push({
                name: `MACD (${key}) [${tf}]`,
                value: `Line: ${lastMacd.macdLine.toFixed(2)} | Hist: ${lastMacd.histogram.toFixed(2)}`,
                signal: isBullish ? 'BULLISH' : isBearish ? 'BEARISH' : 'NEUTRAL',
              });
            }
          }
        }

        if (tfIndicators.volume && tfIndicators.volume.length > 0) {
          const volPeriod = indConfig?.volumeAveragePeriod || 20;
          const lastVol = tfIndicators.volume.slice(-1)[0];
          if (lastVol && !isNaN(lastVol.averageVolume)) {
            const isSurge = lastVol.volumeChangePercent > 20;
            summaries.push({
              name: `Volume MA (${volPeriod}) [${tf}]`,
              value: `Avg: ${lastVol.averageVolume.toFixed(0)} (${lastVol.volumeChangePercent >= 0 ? '+' : ''}${lastVol.volumeChangePercent.toFixed(1)}%)`,
              signal: isSurge ? 'BULLISH' : 'NEUTRAL',
            });
          }
        }

        if (tfIndicators.atr) {
          const atrPeriods = indConfig?.atrPeriods || Object.keys(tfIndicators.atr).map(Number);
          for (const period of atrPeriods) {
            const series = tfIndicators.atr[period];
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

        // Only include SMA if strategy conditionConfig explicitly uses SMA
        if (tfIndicators.sma && conditionConfig?.smaPeriod) {
          const smaPeriods = [conditionConfig.smaPeriod];
          for (const period of smaPeriods) {
            const series = tfIndicators.sma[period];
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

  private static mapCheckpoints(result: EvaluationResult, manifest?: StrategyManifest): ConditionSummary[] {
    const summaries: ConditionSummary[] = [];
    const config = result.metadata?.strategyConfig || manifest?.defaultConfiguration || {};

    if (result.metadata?.conditionResult && result.metadata.conditionResult.timeframes) {
      let chkId = 1;
      for (const [tf, tfResult] of Object.entries(result.metadata.conditionResult.timeframes)) {
        const res = tfResult as any;
        if (res.trend) {
          const fastP = config.conditionConfig?.emaFastPeriod ?? 9;
          const slowP = config.conditionConfig?.emaSlowPeriod ?? 21;
          summaries.push({
            id: `chk_${chkId++}`,
            name: `Trend Alignment (${tf})`,
            currentValue: res.trend.reasoning?.[0] || (res.trend.priceAboveEMA ? `Price > EMA(${fastP})` : 'Divergent'),
            targetValue: `EMA(${fastP}) > EMA(${slowP})`,
            status: (res.trend.priceAboveEMA && res.trend.trendDirection !== 'DOWN') ? 'PASSED' : 'FAILED',
          });
        }
        if (res.momentum) {
          const rsiP = config.conditionConfig?.rsiPeriod ?? 14;
          const rsiOversold = config.conditionConfig?.rsiOversold ?? 30;
          const rsiOverbought = config.conditionConfig?.rsiOverbought ?? 70;
          summaries.push({
            id: `chk_${chkId++}`,
            name: `Momentum Filter (${tf})`,
            currentValue: res.momentum.reasoning?.[0] || (res.momentum.macdDirection === 'BULLISH' ? 'MACD Bullish' : 'Neutral/Bearish'),
            targetValue: `RSI(${rsiP}) [${rsiOversold}-${rsiOverbought}] & MACD > 0`,
            status: (res.momentum.macdDirection === 'BULLISH') ? 'PASSED' : 'FAILED',
          });
        }
        if (res.volatility) {
          const atrP = config.conditionConfig?.atrPeriod ?? 14;
          summaries.push({
            id: `chk_${chkId++}`,
            name: `Volatility Expansion (${tf})`,
            currentValue: res.volatility.reasoning?.[0] || (res.volatility.atrState === 'EXPANDING' ? 'Expanding' : 'Contracting'),
            targetValue: `ATR(${atrP}) Expanding`,
            status: res.volatility.atrState === 'EXPANDING' ? 'PASSED' : 'FAILED',
          });
        }
        if (res.volume) {
          summaries.push({
            id: `chk_${chkId++}`,
            name: `Volume Surge (${tf})`,
            currentValue: res.volume.reasoning?.[0] || (res.volume.volumeConfirmation ? 'Confirmed' : 'Normal'),
            targetValue: 'Volume > 1.20x 20MA',
            status: res.volume.volumeConfirmation ? 'PASSED' : 'FAILED',
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
          targetValue: 'Condition Met',
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
