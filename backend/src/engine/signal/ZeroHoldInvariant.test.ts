import { describe, it, expect } from 'vitest';
import { SignalEngine } from './SignalEngine';
import { SignalType } from './SignalType';
import { SignalRules } from './SignalValidator';
import { SignalContext } from './TradingSignal';
import { ConditionResult } from '../condition';
import { ConfidenceScore } from '../confidence';
import { RiskAssessment } from '../risk';
import { ScalperV2Strategy } from '../strategies/scalper-v2/ScalperV2Strategy';
import { StrategyContext } from '../context/StrategyContext';
import { MarketSnapshot } from '../market-data/MarketSnapshot';
import { Timeframe } from '../market-data/Timeframe';
import { AnalysisSnapshotMapper } from '../../api/engine/AnalysisSnapshotMapper';
import { EvaluationResult } from '../dto/EvaluationResult';
import { StrategyManifest } from '../strategies/StrategyManifest';

describe('Zero-Hold Invariant Suite', () => {
  const rules: SignalRules = {
    minConfidenceScore: 70,
    allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH']
  };

  const context: SignalContext = {
    symbol: 'BTC/USDT',
    timeframe: '15m',
    currentPrice: 50000
  };

  const bullishConditions: ConditionResult = {
    timestamp: 1000,
    timeframes: {
      '15m': {
        trend: { trendDirection: 'UP', emaCrossoverState: 'BULLISH', priceAboveEMA: true },
        momentum: { rsiState: 'NEUTRAL', macdDirection: 'BULLISH' },
        volatility: { atrState: 'EXPANDING' },
        volume: { volumeTrend: 'INCREASING', volumeConfirmation: true }
      }
    }
  };

  const neutralConditions: ConditionResult = {
    timestamp: 1000,
    timeframes: {
      '15m': {
        trend: { trendDirection: 'SIDEWAYS', emaCrossoverState: 'NONE', priceAboveEMA: false },
        momentum: { rsiState: 'NEUTRAL', macdDirection: 'NEUTRAL' },
        volatility: { atrState: 'NEUTRAL' },
        volume: { volumeTrend: 'NEUTRAL', volumeConfirmation: false }
      }
    }
  };

  const highConfidence: ConfidenceScore = {
    timestamp: 1000,
    overallScore: 85,
    overallLongScore: 85,
    overallShortScore: 0,
    overallLevel: 'HIGH',
    timeframes: {
      '15m': {
        score: 85,
        longScore: 85,
        shortScore: 0,
        level: 'HIGH',
        factors: { trendScore: 100, momentumScore: 100, volatilityScore: 100, volumeScore: 100 },
        explanation: ['All factors strong']
      }
    }
  };

  const acceptableRisk: RiskAssessment = {
    timestamp: 1000,
    stopLossDistance: 500,
    takeProfitDistance: 1000,
    riskRewardRatio: 2.0,
    positionSizeRecommendation: 1000,
    maximumExposure: 5000,
    riskClassification: 'MEDIUM',
    explanation: ['Valid risk profile']
  };

  it('Invariant 1: SignalType enum must only define BUY and SELL, never HOLD', () => {
    const enumKeys = Object.keys(SignalType);
    const enumValues = Object.values(SignalType);

    expect(enumKeys).toEqual(['BUY', 'SELL']);
    expect(enumValues).toEqual(['BUY', 'SELL']);
    expect((SignalType as any).HOLD).toBeUndefined();
  });

  it('Invariant 2: Unqualified setup due to low confidence returns null (never HOLD, never dummy signal)', () => {
    const engine = new SignalEngine(rules);
    const lowConfidence: ConfidenceScore = {
      ...highConfidence,
      overallScore: 50,
      overallLongScore: 50,
      overallShortScore: 0,
      timeframes: {
        '15m': { ...highConfidence.timeframes['15m'], score: 50, longScore: 50, shortScore: 0 }
      }
    };

    const signal = engine.evaluate(context, bullishConditions, lowConfidence, acceptableRisk);
    expect(signal).toBeNull();
  });

  it('Invariant 3: Unqualified setup due to neutral conditions returns null', () => {
    const engine = new SignalEngine(rules);
    const signal = engine.evaluate(context, neutralConditions, highConfidence, acceptableRisk);
    expect(signal).toBeNull();
  });

  it('Invariant 4: Unqualified setup due to rejected risk returns null', () => {
    const engine = new SignalEngine(rules);
    const extremeRisk: RiskAssessment = {
      ...acceptableRisk,
      riskClassification: 'EXTREME'
    };

    const signal = engine.evaluate(context, bullishConditions, highConfidence, extremeRisk);
    expect(signal).toBeNull();
  });

  it('Invariant 5: Qualified BUY setup generates BUY signal with complete parameters', () => {
    const engine = new SignalEngine(rules);
    const signal = engine.evaluate(context, bullishConditions, highConfidence, acceptableRisk);

    expect(signal).not.toBeNull();
    expect(signal!.type).toBe(SignalType.BUY);
    expect(signal!.signalPrice).toBe(50000);
    expect(signal!.entryPrice).toBe(50000);
    expect(signal!.stopLoss).toBe(49500);
    expect(signal!.takeProfit).toBe(51000);
    expect(signal!.confidenceScore).toBe(85);
  });

  it('Invariant 6: Long-only strategy suppresses SELL to null (never converts to BUY or HOLD)', () => {
    const strategy = new ScalperV2Strategy();
    const bearishSnapshot: MarketSnapshot = {
      symbol: 'BTC/USDT',
      timestamp: Date.now(),
      currentPrice: 80,
      volume24h: 10000,
      quoteVolume24h: 800000,
      metadata: { priceChange24h: -10, priceChangePercent24h: -10, highPrice24h: 100, lowPrice24h: 75 },
      candles: {
        '5m': [
          { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
          { timestamp: 2, open: 100, high: 100, low: 85, close: 90, volume: 1200 },
          { timestamp: 3, open: 90, high: 90, low: 75, close: 80, volume: 2000 }
        ]
      } as any
    };

    const ctx = new StrategyContext(bearishSnapshot).freeze();
    const result = strategy.evaluate(ctx);

    // Must NOT convert to BUY
    expect(result.metadata.signal?.type).not.toBe('BUY');
    // If short was suppressed, must be null
    if (result.metadata.reasoning.some((r: string) => r.includes('Short signal suppressed'))) {
      expect(result.hasSignal).toBe(false);
      expect(result.metadata.signal).toBeNull();
    }
  });

  it('Invariant 7: AnalysisSnapshotMapper maps unqualified result to tradingSignal: null and opportunity: null', () => {
    const evalResult: EvaluationResult = {
      strategyId: 'ScalperV2',
      timestamp: Date.now(),
      confidenceScore: 0,
      hasSignal: false,
      metadata: {
        reasoning: ['No setup found'],
        signal: null
      }
    };

    const manifest: StrategyManifest = {
      id: 'ScalperV2',
      displayName: 'Scalper V2',
      category: 'Scalping',
      version: '2.0.0',
      description: 'Scalper',
      riskProfile: 'High',
      supportedMarkets: ['CRYPTO'],
      supportedTimeframes: ['5m', '15m'] as Timeframe[],
      minimumCandles: 50,
      defaultConfiguration: {
        preferredTimeframes: ['5m'],
        indicatorConfig: { rsiPeriods: [14], smaPeriods: [20, 50], emaPeriods: [9, 21], macdParams: [{ fast: 12, slow: 26, signal: 9 }], atrPeriods: [14], volumeAveragePeriod: 20 },
        conditionConfig: { emaFastPeriod: 9, emaSlowPeriod: 21, rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30, macdKey: '12,26,9', atrPeriod: 14, volumePeriod: 20 },
        confidenceWeights: { trend: 35, momentum: 25, volatility: 20, volume: 20 },
        signalRules: { minConfidenceScore: 70 }
      },
      supportsLong: true,
      supportsShort: false,
      supportsPaperTrading: true,
      supportsLiveTrading: true,
      status: 'ACTIVE',
      author: 'System',
      parameters: []
    };

    const snapshot: MarketSnapshot = {
      symbol: 'BTC/USDT',
      timestamp: Date.now(),
      currentPrice: 50000,
      volume24h: 1000,
      quoteVolume24h: 50000000,
      metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 50500, lowPrice24h: 49500 },
      candles: { '5m': [], '15m': [] } as any
    };

    const dto = AnalysisSnapshotMapper.map(evalResult, manifest, snapshot);
    expect(dto.tradingSignal).toBeNull();
    expect(dto.opportunity).toBeNull();
  });
});
