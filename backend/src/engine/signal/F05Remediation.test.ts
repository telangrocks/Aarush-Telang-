import { describe, it, expect } from 'vitest';
import { StrategyRegistry } from '../strategies/StrategyRegistry';
import { SignalEngine } from './SignalEngine';
import { SignalType } from './SignalType';
import { SignalRules } from './SignalValidator';
import { SignalContext } from './TradingSignal';
import { ConditionResult } from '../condition';
import { ConfidenceScore } from '../confidence';
import { RiskAssessment } from '../risk';
import { StrategyContext } from '../context/StrategyContext';
import { MarketSnapshot, NormalizedCandle } from '../market-data/MarketSnapshot';
import { TradeValidator } from '../../validation/TradeValidator';
import BigNumber from 'bignumber.js';

describe('F-05 Remediation & Synthetic Signal Injection Elimination', () => {
  const signalContext: SignalContext = {
    symbol: 'BTC/USDT',
    timeframe: '15m',
    currentPrice: 50000
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

  const bearishConditions: ConditionResult = {
    timestamp: 1000,
    timeframes: {
      '15m': {
        trend: { trendDirection: 'DOWN', emaCrossoverState: 'BEARISH', priceAboveEMA: false },
        momentum: { rsiState: 'NEUTRAL', macdDirection: 'BEARISH' },
        volatility: { atrState: 'EXPANDING' },
        volume: { volumeTrend: 'INCREASING', volumeConfirmation: true }
      }
    }
  };

  const failingConfidence: ConfidenceScore = {
    timestamp: 1000,
    overallScore: 30,
    overallLongScore: 30,
    overallShortScore: 10,
    overallLevel: 'LOW',
    timeframes: {
      '15m': {
        score: 30,
        longScore: 30,
        shortScore: 10,
        level: 'LOW',
        factors: {
          trendScore: 10,
          momentumScore: 10,
          volatilityScore: 5,
          volumeScore: 5
        },
        explanation: []
      }
    }
  };

  const validBuyConfidence: ConfidenceScore = {
    timestamp: 1000,
    overallScore: 80,
    overallLongScore: 80,
    overallShortScore: 10,
    overallLevel: 'HIGH',
    timeframes: {
      '15m': {
        score: 80,
        longScore: 80,
        shortScore: 10,
        level: 'HIGH',
        factors: {
          trendScore: 40,
          momentumScore: 25,
          volatilityScore: 10,
          volumeScore: 10
        },
        explanation: []
      }
    }
  };

  const validSellConfidence: ConfidenceScore = {
    timestamp: 1000,
    overallScore: 80,
    overallLongScore: 10,
    overallShortScore: 80,
    overallLevel: 'HIGH',
    timeframes: {
      '15m': {
        score: 80,
        longScore: 10,
        shortScore: 80,
        level: 'HIGH',
        factors: {
          trendScore: 40,
          momentumScore: 25,
          volatilityScore: 10,
          volumeScore: 10
        },
        explanation: []
      }
    }
  };

  const acceptableRisk: RiskAssessment = {
    timestamp: 1000,
    riskClassification: 'LOW',
    maximumExposure: 25,
    positionSizeRecommendation: 1000,
    stopLossDistance: 500,
    takeProfitDistance: 1000,
    riskRewardRatio: 2.0,
    explanation: ['Risk is low']
  };

  const standardRules: SignalRules = {
    minConfidenceScore: 70,
    allowedRiskClassifications: ['LOW', 'MEDIUM']
  };

  it('1. StrategyRegistry does NOT map parameters.forceMockSignal into signalRules', () => {
    const registry = StrategyRegistry.getInstance();
    const configWithInjection = {
      parameters: {
        forceMockSignal: 'BUY'
      }
    };
    const strategy = registry.createStrategy('ScalperV2', configWithInjection as any)!;
    expect(strategy).toBeDefined();
    // Verify that the internal signalEngine rules do NOT have forceMockSignal
    const rules = (strategy as any).config.signalRules;
    expect(rules.forceMockSignal).toBeUndefined();
  });

  it('2. SignalEngine cannot manufacture a BUY signal when market conditions are neutral', () => {
    const engine = new SignalEngine(standardRules);
    // Even if caller attempts to pass forceMockSignal in any way:
    (engine as any).rules = { ...standardRules, forceMockSignal: 'BUY' };
    const signal = engine.evaluate(signalContext, neutralConditions, failingConfidence, acceptableRisk);
    expect(signal).toBeNull();
  });

  it('3. SignalEngine cannot manufacture a SELL signal when market conditions are neutral', () => {
    const engine = new SignalEngine(standardRules);
    (engine as any).rules = { ...standardRules, forceMockSignal: 'SELL' };
    const signal = engine.evaluate(signalContext, neutralConditions, failingConfidence, acceptableRisk);
    expect(signal).toBeNull();
  });

  it('4. Invalid Model C validation cannot be bypassed by any injection', () => {
    const engine = new SignalEngine(standardRules);
    // Bullish trend proposes BUY, but confidence fails Model C (score 30 < 70)
    const signal = engine.evaluate(signalContext, bullishConditions, failingConfidence, acceptableRisk);
    expect(signal).toBeNull();

    // Conflicting directional scores (both LongScore and ShortScore >= 70)
    const conflictingConfidence: ConfidenceScore = {
      ...validBuyConfidence,
      timeframes: {
        '15m': {
          ...validBuyConfidence.timeframes['15m'],
          longScore: 75,
          shortScore: 75
        }
      }
    };
    const conflictSignal = engine.evaluate(signalContext, bullishConditions, conflictingConfidence, acceptableRisk);
    expect(conflictSignal).toBeNull();
  });

  it('5. ScalperV2 activated with legacy injection payload produces NO synthetic signal', () => {
    const registry = StrategyRegistry.getInstance();
    const strategy = registry.createStrategy('ScalperV2', {
      parameters: { forceMockSignal: 'BUY' }
    } as any)!;

    // Create realistic neutral market candles
    const basePrice = 50000;
    const candles: NormalizedCandle[] = [];
    for (let i = 0; i < 100; i++) {
      candles.push({
        timestamp: 100000 + i * 60000,
        openTime: 100000 + i * 60000,
        open: basePrice,
        high: basePrice + 10,
        low: basePrice - 10,
        close: basePrice,
        volume: 100
      });
    }

    const snapshot: MarketSnapshot = {
      symbol: 'BTC/USDT',
      timestamp: Date.now(),
      currentPrice: basePrice,
      volume24h: 1000,
      quoteVolume24h: 50000000,
      candles: {
        '5m': candles,
        '15m': candles
      } as any,
      metadata: {
        priceChange24h: 0,
        priceChangePercent24h: 0,
        highPrice24h: basePrice + 100,
        lowPrice24h: basePrice - 100
      }
    };

    const context = new StrategyContext(snapshot, 10000).freeze();
    const result = strategy.evaluate(context);

    // Invariant: no synthetic signal is manufactured
    expect(result.hasSignal).toBe(false);
    expect(result.metadata.signal).toBeNull();
  });

  it('6. Legitimate qualified BUY signals remain 100% operational', () => {
    const engine = new SignalEngine(standardRules);
    const signal = engine.evaluate(signalContext, bullishConditions, validBuyConfidence, acceptableRisk);

    expect(signal).not.toBeNull();
    expect(signal?.type).toBe(SignalType.BUY);
    expect(signal?.confidenceScore).toBe(80);
    expect(signal?.stopLoss).toBe(49500); // 50000 - 500
    expect(signal?.takeProfit).toBe(51000); // 50000 + 1000
  });

  it('7. Legitimate qualified SELL signals remain 100% operational for short-supporting strategies', () => {
    const engine = new SignalEngine(standardRules);
    const signal = engine.evaluate(signalContext, bearishConditions, validSellConfidence, acceptableRisk);

    expect(signal).not.toBeNull();
    expect(signal?.type).toBe(SignalType.SELL);
    expect(signal?.confidenceScore).toBe(80);
    expect(signal?.stopLoss).toBe(50500); // 50000 + 500
    expect(signal?.takeProfit).toBe(49000); // 50000 - 1000
  });

  it('8. Model A sizing contract remains fully authoritative and unchanged', () => {
    // Sizing validation with 5 USDT allocation at 50,000 USDT price
    const rulesRes = TradeValidator.validate({
      symbol: 'BTC/USDT',
      side: 'BUY',
      orderType: 'MARKET',
      entryIntent: 'IMMEDIATE',
      entryPrice: 50000,
      currentMarketPrice: 50000,
      markPrice: 50000,
      tradeValueUsdt: 5.0
    }, {
      schemaVersion: '2.0',
      symbol: 'BTC/USDT',
      exchange: 'bybit',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      minNotional: 5,
      minQty: 0.00001,
      maxQty: 999999,
      stepSize: 0.00001,
      tickSize: 0.01,
      minPrice: 0,
      maxPrice: 999999999,
      contractSize: 1,
      priceLimitRatioX: 0.1,
      priceLimitRatioY: 0.1,
      markPrice: 50000,
      lastUpdated: Date.now()
    });

    expect(rulesRes.isValid).toBe(true);
    expect(rulesRes.quantizedQuantity).toBe(0.0001); // 5 / 50000 = 0.0001
    expect(rulesRes.postRoundingNotional).toBe(5.0);
  });
});
