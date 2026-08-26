import { describe, it, expect } from 'vitest';
import { AnalysisSnapshotMapper } from './AnalysisSnapshotMapper';
import { EvaluationResult } from '../../engine/dto/EvaluationResult';
import { StrategyManifest } from '../../engine/strategies/StrategyManifest';
import { MarketSnapshot } from '../../engine/market-data/MarketSnapshot';

describe('AnalysisSnapshotMapper Unit Tests', () => {
  const dummyManifest: StrategyManifest = {
    id: 'ScalperV2',
    displayName: 'Scalper V2',
    description: 'High-frequency trend-following scalper',
    version: '2.0.0',
    category: 'Scalping',
    riskProfile: 'High',
    supportedMarkets: ['CRYPTO'],
    supportedTimeframes: ['5m'],
    minimumCandles: 50,
    defaultConfiguration: {},
    supportsLong: true,
    supportsShort: false,
    supportsPaperTrading: true,
    supportsLiveTrading: true,
    status: 'ACTIVE',
    author: 'System',
    parameters: []
  };

  const dummySnapshot: MarketSnapshot = {
    symbol: 'BTCUSDT',
    timestamp: 1722814800000,
    currentPrice: 65000.0,
    volume24h: 1200000.0,
    quoteVolume24h: 1200000.0,
    candles: {
      '1m': [],
      '3m': [],
      '5m': [
        { timestamp: 1722814800000, open: 64900, high: 65100, low: 64850, close: 65000, volume: 15.5 }
      ],
      '15m': [],
      '30m': [],
      '1h': [],
      '4h': []
    },
    metadata: {
      priceChange24h: 1000.0,
      priceChangePercent24h: 1.56,
      highPrice24h: 65500.0,
      lowPrice24h: 63800.0
    }
  };

  it('should map complete evaluation result correctly in Preview Mode (isLive = false)', () => {
    const evalResult: EvaluationResult = {
      strategyId: 'ScalperV2',
      timestamp: 1722814800000,
      confidenceScore: 85,
      hasSignal: true,
      metadata: {
        reasoning: ['EMA 9 > EMA 21 bullish cross', 'RSI in healthy zone (58.4)'],
        signal: {
          type: 'BUY',
          side: 'LONG',
          currentPrice: 65000.0,
          signalPrice: 65000.0,
          targetEntryPrice: 65000.0,
          stopLoss: 64500.0,
          takeProfit: 66000.0
        },
        indicatorSnapshot: {
          timestamp: 1722814800000,
          timeframes: {
            '5m': {
              close: [65000],
              rsi: { 14: [58.4] },
              sma: {},
              ema: { 9: [65100], 21: [64800] },
              macd: {},
              atr: { 14: [350.0] },
              volume: []
            }
          }
        }
      }
    };

    const dto = AnalysisSnapshotMapper.map(evalResult, dummyManifest, dummySnapshot, 'ACTIVE', false);

    expect(dto.symbol).toBe('BTCUSDT');
    expect(dto.strategy).toBe('ScalperV2');
    expect(dto.price).toBe(65000.0);
    expect(dto.change24h).toBe(1.56);
    expect(dto.volume).toBe(1200000.0);
    expect(dto.high24h).toBe(65500.0);
    expect(dto.low24h).toBe(63800.0);

    // Engine Status
    expect(dto.engineStatus.state).toBe('ACTIVE');
    expect(dto.engineStatus.activeStrategy).toBe('ScalperV2');
    expect(dto.engineStatus.health).toBe('OK');

    // Market Analysis
    expect(dto.marketAnalysis.symbol).toBe('BTCUSDT');
    expect(dto.marketAnalysis.confidenceScore).toBe(85);
    expect(dto.marketAnalysis.indicatorSummary).toHaveLength(4); // RSI (14), EMA (9), EMA (21), ATR (14)
    expect(dto.marketAnalysis.indicatorSummary[0].name).toContain('RSI (14)');
    expect(dto.marketAnalysis.indicatorSummary[0].value).toBe('58.4');

    // Trading Signal
    expect(dto.tradingSignal.type).toBe('BUY');
    expect(dto.tradingSignal.entryContext).toBe('LONG');
    expect(dto.tradingSignal.signalPrice).toBe(65000.0);

    // Diagnostics
    expect(dto.diagnostics.isLive).toBe(false);

    // Legacy Fallback Root Fields
    expect(dto.indicators.rsi).toBe(58.4);
    expect(dto.indicators.atr).toBe(350.0);
    expect(dto.progress).toBe(85);
    expect(dto.opportunity).not.toBeNull();
    expect(dto.opportunity?.side).toBe('BUY');
  });

  it('should map correctly in Live Mode (isLive = true)', () => {
    const evalResult: EvaluationResult = {
      strategyId: 'ScalperV2',
      timestamp: 1722814800000,
      confidenceScore: 92,
      hasSignal: false,
      metadata: {
        reasoning: ['Scanning active']
      }
    };

    const dto = AnalysisSnapshotMapper.map(evalResult, dummyManifest, dummySnapshot, 'WAITING', true);

    expect(dto.engineStatus.state).toBe('WAITING');
    expect(dto.diagnostics.isLive).toBe(true);
    expect(dto.tradingSignal.type).toBe('HOLD');
    expect(dto.opportunity).toBeNull();
  });

  it('should gracefully handle missing or empty metadata properties', () => {
    const emptyResult: EvaluationResult = {
      strategyId: 'ScalperV2',
      timestamp: 1722814800000,
      confidenceScore: 0,
      hasSignal: false,
      metadata: {
        reasoning: []
      }
    };

    const emptySnapshot: MarketSnapshot = {
      symbol: 'ETHUSDT',
      timestamp: 1722814800000,
      currentPrice: 3000.0,
      volume24h: 0,
      quoteVolume24h: 0,
      candles: {
        '1m': [],
        '3m': [],
        '5m': [],
        '15m': [],
        '30m': [],
        '1h': [],
        '4h': []
      },
      metadata: {
        priceChange24h: 0,
        priceChangePercent24h: 0,
        highPrice24h: 3000.0,
        lowPrice24h: 3000.0
      }
    };

    const dto = AnalysisSnapshotMapper.map(emptyResult, dummyManifest, emptySnapshot);

    expect(dto.symbol).toBe('ETHUSDT');
    expect(dto.price).toBe(3000.0);
    expect(dto.change24h).toBe(0);
    expect(dto.marketAnalysis.indicatorSummary).toEqual([
      { name: 'Data Status', value: 'Insufficient', signal: 'NEUTRAL' }
    ]);
    expect(dto.marketAnalysis.conditionSummary).toEqual([]);
    expect(dto.tradingSignal.type).toBe('HOLD');
    expect(dto.opportunity).toBeNull();
  });

  it('should map ScalperV2 with correct 5m primary timeframe and factor weights', () => {
    const scalperManifest: StrategyManifest = {
      id: 'ScalperV2',
      displayName: 'Scalper V2',
      description: 'Scalping',
      version: '2.0.0',
      category: 'Scalping',
      riskProfile: 'High',
      supportedMarkets: ['CRYPTO'],
      supportedTimeframes: ['5m', '15m', '30m'],
      minimumCandles: 200,
      defaultConfiguration: {
        preferredTimeframes: ['5m', '15m', '30m'],
        confidenceWeights: { trend: 40, momentum: 30, volatility: 15, volume: 15 },
        signalRules: { minConfidenceScore: 75 }
      },
      supportsLong: true,
      supportsShort: false,
      supportsPaperTrading: true,
      supportsLiveTrading: true,
      status: 'ACTIVE',
      author: 'System',
      parameters: [
        { key: 'risk_level', displayName: 'Risk Level', type: 'ENUM', defaultValue: 'Medium', isRequired: true, options: ['Low', 'Medium', 'High'] },
        { key: 'mode', displayName: 'Mode', type: 'ENUM', defaultValue: 'Aggressive', isRequired: true, options: ['Conservative', 'Moderate', 'Aggressive'] }
      ]
    };

    const evalResult: EvaluationResult = {
      strategyId: 'ScalperV2',
      timestamp: 1722814800000,
      confidenceScore: 85,
      hasSignal: true,
      metadata: {
        reasoning: ['Bullish scalper setup'],
        strategyConfig: scalperManifest.defaultConfiguration,
        confidenceScore: {
          timestamp: 1722814800000,
          overallScore: 85,
          overallLevel: 'HIGH',
          timeframes: {
            '5m': {
              score: 85,
              level: 'HIGH',
              factors: { trendScore: 100, momentumScore: 100, volatilityScore: 100, volumeScore: 50 },
              explanation: ['Bullish']
            }
          }
        }
      }
    };

    const dto = AnalysisSnapshotMapper.map(evalResult, scalperManifest, dummySnapshot);

    expect(dto.strategyMetadata).toBeDefined();
    expect(dto.strategyMetadata?.strategyId).toBe('ScalperV2');
    expect(dto.strategyMetadata?.displayName).toBe('Scalper V2');
    expect(dto.strategyMetadata?.primaryTimeframe).toBe('5m');
    expect(dto.strategyMetadata?.timeframesAnalyzed).toEqual(['5m', '15m', '30m']);
    expect(dto.strategyMetadata?.factorContributions).toEqual([
      { factor: 'Trend Alignment', weight: 40, score: 100, level: 'HIGH' },
      { factor: 'Momentum Filter', weight: 30, score: 100, level: 'HIGH' },
      { factor: 'Volatility Buffer', weight: 15, score: 100, level: 'HIGH' },
      { factor: 'Volume Confirmation', weight: 15, score: 50, level: 'MEDIUM' }
    ]);
  });

  it('should map VWAP Strategy with custom indicators (VWAP Fair Value, Deviation) and 30/20/10/40 weights', () => {
    const vwapManifest: StrategyManifest = {
      id: 'VWAP',
      displayName: 'VWAP Strategy',
      description: 'VWAP Trading',
      version: '1.0.0',
      category: 'Mean Reversion',
      riskProfile: 'Medium',
      supportedMarkets: ['CRYPTO'],
      supportedTimeframes: ['15m', '1h', '4h'],
      minimumCandles: 200,
      defaultConfiguration: {
        preferredTimeframes: ['15m', '1h', '4h'],
        confidenceWeights: { trend: 30, momentum: 20, volatility: 10, volume: 40 },
        signalRules: { minConfidenceScore: 70 },
        vwapRules: { maxDeviationThresholdPercent: 3.0, minVolumeMultiplier: 1.5, minSidewaysDisplacementPercent: 0.2 }
      },
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

    const evalResult: EvaluationResult = {
      strategyId: 'VWAP',
      timestamp: 1722814800000,
      confidenceScore: 82,
      hasSignal: true,
      metadata: {
        reasoning: ['VWAP breakout confirmed'],
        strategyConfig: vwapManifest.defaultConfiguration,
        customIndicators: [
          { name: 'VWAP Fair Value', value: '$64850.00', signal: 'BULLISH' },
          { name: 'VWAP Deviation', value: '0.23%', signal: 'BULLISH' },
          { name: 'Volume Multiplier', value: '1.75x', signal: 'BULLISH' },
          { name: 'Price Displacement', value: '0.35%', signal: 'BULLISH' }
        ],
        confidenceScore: {
          timestamp: 1722814800000,
          overallScore: 82,
          overallLevel: 'HIGH',
          timeframes: {
            '15m': {
              score: 82,
              level: 'HIGH',
              factors: { trendScore: 75, momentumScore: 100, volatilityScore: 100, volumeScore: 100 },
              explanation: ['VWAP breakout confirmed']
            }
          }
        }
      }
    };

    const dto = AnalysisSnapshotMapper.map(evalResult, vwapManifest, dummySnapshot);

    expect(dto.strategyMetadata?.displayName).toBe('VWAP Strategy');
    expect(dto.strategyMetadata?.primaryTimeframe).toBe('15m');
    expect(dto.strategyMetadata?.timeframesAnalyzed).toEqual(['15m', '1h', '4h']);
    expect(dto.strategyMetadata?.factorContributions).toEqual([
      { factor: 'Trend Alignment', weight: 30, score: 75, level: 'MEDIUM' },
      { factor: 'Momentum Filter', weight: 20, score: 100, level: 'HIGH' },
      { factor: 'Volatility Buffer', weight: 10, score: 100, level: 'HIGH' },
      { factor: 'Volume Confirmation', weight: 40, score: 100, level: 'HIGH' }
    ]);
    expect(dto.marketAnalysis.indicatorSummary[0].name).toBe('VWAP Fair Value');
    expect(dto.marketAnalysis.indicatorSummary[0].value).toBe('$64850.00');
    expect(dto.marketAnalysis.indicatorSummary[1].name).toBe('VWAP Deviation');
  });

  it('should map Mean Reversion with EMA Separation and 10/40/30/20 weights', () => {
    const mrManifest: StrategyManifest = {
      id: 'MeanReversion',
      displayName: 'Mean Reversion',
      description: 'Mean Reversion',
      version: '1.0.0',
      category: 'Mean Reversion',
      riskProfile: 'Medium-High',
      supportedMarkets: ['CRYPTO'],
      supportedTimeframes: ['15m', '1h'],
      minimumCandles: 200,
      defaultConfiguration: {
        preferredTimeframes: ['15m', '1h'],
        confidenceWeights: { trend: 10, momentum: 40, volatility: 30, volume: 20 },
        signalRules: { minConfidenceScore: 75 },
        trendFilter: { maxEmaSeparationPercent: 5.0, requireTrendStabilization: true },
        entryRules: { requireTwoStepConfirmation: true }
      },
      supportsLong: true,
      supportsShort: true,
      supportsPaperTrading: true,
      supportsLiveTrading: true,
      status: 'ACTIVE',
      author: 'System',
      parameters: []
    };

    const evalResult: EvaluationResult = {
      strategyId: 'MeanReversion',
      timestamp: 1722814800000,
      confidenceScore: 78,
      hasSignal: false,
      metadata: {
        reasoning: ['Mean reversion potential'],
        strategyConfig: mrManifest.defaultConfiguration,
        customIndicators: [
          { name: 'EMA Separation', value: '2.10%', signal: 'BULLISH' },
          { name: '2-Step Reversal', value: 'Oversold Bounce', signal: 'BULLISH' }
        ]
      }
    };

    const dto = AnalysisSnapshotMapper.map(evalResult, mrManifest, dummySnapshot);

    expect(dto.strategyMetadata?.displayName).toBe('Mean Reversion');
    expect(dto.strategyMetadata?.primaryTimeframe).toBe('15m');
    expect(dto.strategyMetadata?.timeframesAnalyzed).toEqual(['15m', '1h']);
    expect(dto.strategyMetadata?.factorContributions[0].weight).toBe(10);
    expect(dto.strategyMetadata?.factorContributions[1].weight).toBe(40);
    expect(dto.marketAnalysis.indicatorSummary[0].name).toBe('EMA Separation');
    expect(dto.marketAnalysis.indicatorSummary[0].value).toBe('2.10%');
  });

  it('should map Momentum Strategy with 15m primary timeframe and 30/50/10/10 weights', () => {
    const momentumManifest: StrategyManifest = {
      id: 'Momentum',
      displayName: 'Momentum Trading Strategy',
      description: 'Momentum Trading',
      version: '1.0.0',
      category: 'Trend Following',
      riskProfile: 'Medium-High',
      supportedMarkets: ['CRYPTO'],
      supportedTimeframes: ['15m', '1h', '4h'],
      minimumCandles: 200,
      defaultConfiguration: {
        preferredTimeframes: ['15m', '1h', '4h'],
        confidenceWeights: { trend: 30, momentum: 50, volatility: 10, volume: 10 },
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

    const evalResult: EvaluationResult = {
      strategyId: 'Momentum',
      timestamp: 1722814800000,
      confidenceScore: 84,
      hasSignal: true,
      metadata: {
        reasoning: ['Momentum confirmed'],
        strategyConfig: momentumManifest.defaultConfiguration,
        confidenceScore: {
          timestamp: 1722814800000,
          overallScore: 84,
          overallLevel: 'HIGH',
          timeframes: {
            '15m': {
              score: 84,
              level: 'HIGH',
              factors: { trendScore: 80, momentumScore: 95, volatilityScore: 60, volumeScore: 70 },
              explanation: ['Momentum confirmed']
            }
          }
        }
      }
    };

    const dto = AnalysisSnapshotMapper.map(evalResult, momentumManifest, dummySnapshot);

    expect(dto.strategyMetadata?.displayName).toBe('Momentum Trading Strategy');
    expect(dto.strategyMetadata?.primaryTimeframe).toBe('15m');
    expect(dto.strategyMetadata?.timeframesAnalyzed).toEqual(['15m', '1h', '4h']);
    expect(dto.strategyMetadata?.factorContributions).toEqual([
      { factor: 'Trend Alignment', weight: 30, score: 80, level: 'HIGH' },
      { factor: 'Momentum Filter', weight: 50, score: 95, level: 'HIGH' },
      { factor: 'Volatility Buffer', weight: 10, score: 60, level: 'MEDIUM' },
      { factor: 'Volume Confirmation', weight: 10, score: 70, level: 'MEDIUM' }
    ]);
  });

  it('should map Breakout Strategy with 15m primary timeframe and 30/30/20/20 weights', () => {
    const breakoutManifest: StrategyManifest = {
      id: 'Breakout',
      displayName: 'Breakout Strategy',
      description: 'Breakout Strategy',
      version: '1.0.0',
      category: 'Breakout',
      riskProfile: 'Medium-High',
      supportedMarkets: ['CRYPTO'],
      supportedTimeframes: ['15m', '1h', '4h'],
      minimumCandles: 200,
      defaultConfiguration: {
        preferredTimeframes: ['15m', '1h', '4h'],
        confidenceWeights: { trend: 30, momentum: 30, volatility: 20, volume: 20 },
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

    const evalResult: EvaluationResult = {
      strategyId: 'Breakout',
      timestamp: 1722814800000,
      confidenceScore: 88,
      hasSignal: true,
      metadata: {
        reasoning: ['Breakout confirmed'],
        strategyConfig: breakoutManifest.defaultConfiguration,
        confidenceScore: {
          timestamp: 1722814800000,
          overallScore: 88,
          overallLevel: 'HIGH',
          timeframes: {
            '15m': {
              score: 88,
              level: 'HIGH',
              factors: { trendScore: 85, momentumScore: 85, volatilityScore: 90, volumeScore: 90 },
              explanation: ['Breakout confirmed']
            }
          }
        }
      }
    };

    const dto = AnalysisSnapshotMapper.map(evalResult, breakoutManifest, dummySnapshot);

    expect(dto.strategyMetadata?.displayName).toBe('Breakout Strategy');
    expect(dto.strategyMetadata?.primaryTimeframe).toBe('15m');
    expect(dto.strategyMetadata?.timeframesAnalyzed).toEqual(['15m', '1h', '4h']);
    expect(dto.strategyMetadata?.factorContributions).toEqual([
      { factor: 'Trend Alignment', weight: 30, score: 85, level: 'HIGH' },
      { factor: 'Momentum Filter', weight: 30, score: 85, level: 'HIGH' },
      { factor: 'Volatility Buffer', weight: 20, score: 90, level: 'HIGH' },
      { factor: 'Volume Confirmation', weight: 20, score: 90, level: 'HIGH' }
    ]);
  });

  it('should preserve authentic mathematical Strategy Score on HOLD, serialize MACD/Volume, and omit unused SMAs', () => {
    const scalperManifest: StrategyManifest = {
      id: 'ScalperV2',
      displayName: 'Scalper V2',
      description: 'Scalping',
      version: '2.0.0',
      category: 'Scalping',
      riskProfile: 'High',
      supportedMarkets: ['CRYPTO'],
      supportedTimeframes: ['15m'],
      minimumCandles: 200,
      defaultConfiguration: {
        preferredTimeframes: ['15m'],
        indicatorConfig: {
          rsiPeriods: [14],
          smaPeriods: [50, 200],
          emaPeriods: [9, 21],
          macdParams: [{ fast: 12, slow: 26, signal: 9 }],
          atrPeriods: [14],
          volumeAveragePeriod: 20
        },
        conditionConfig: {
          emaFastPeriod: 9,
          emaSlowPeriod: 21,
          rsiPeriod: 14,
          rsiOverbought: 70,
          rsiOversold: 30,
          macdKey: '12,26,9',
          atrPeriod: 14,
          volumePeriod: 20
        },
        confidenceWeights: { trend: 40, momentum: 30, volatility: 15, volume: 15 },
        signalRules: { minConfidenceScore: 75 }
      },
      supportsLong: true,
      supportsShort: false,
      supportsPaperTrading: true,
      supportsLiveTrading: true,
      status: 'ACTIVE',
      author: 'System',
      parameters: []
    };

    const evalResult: EvaluationResult = {
      strategyId: 'ScalperV2',
      timestamp: 1722814800000,
      confidenceScore: 0, // Clamped to 0 by SignalEngine on HOLD
      hasSignal: false,
      metadata: {
        reasoning: ['Waiting for momentum confirmation'],
        strategyConfig: scalperManifest.defaultConfiguration,
        signal: {
          type: 'HOLD',
          confidenceScore: 0,
          timestamp: 1722814800000,
          reasoning: ['Waiting for momentum confirmation']
        },
        confidenceScore: {
          timestamp: 1722814800000,
          overallScore: 61, // Authentic mathematical score
          overallLevel: 'MEDIUM',
          timeframes: {
            '15m': {
              score: 61,
              level: 'MEDIUM',
              factors: { trendScore: 75, momentumScore: 50, volatilityScore: 100, volumeScore: 0 },
              explanation: ['Trend positive, momentum neutral']
            }
          }
        },
        conditionResult: {
          timestamp: 1722814800000,
          timeframes: {
            '15m': {
              trend: {
                priceAboveEMA: true,
                emaFast: 65300,
                emaSlow: 65100,
                trendDirection: 'UP',
                reasoning: ['Price > EMA(9)']
              },
              momentum: {
                macdDirection: 'BEARISH',
                rsiState: 'NEUTRAL',
                reasoning: ['Neutral/Bearish (MACD < 0)']
              },
              volatility: {
                atrState: 'EXPANDING',
                reasoning: ['Expanding']
              },
              volume: {
                volumeConfirmation: false,
                volumeTrend: 'NORMAL',
                reasoning: ['Normal (0.82x MA20)']
              }
            }
          }
        },
        indicatorSnapshot: {
          timestamp: 1722814800000,
          timeframes: {
            '15m': {
              close: [65432],
              rsi: { 14: [48.2] },
              ema: { 9: [65300], 21: [65100] },
              sma: { 50: [64800], 200: [63500] },
              macd: { '12,26,9': [{ macdLine: -12.4, signalLine: -8.2, histogram: -4.2 }] },
              atr: { 14: [245.5] },
              volume: [{ averageVolume: 14200, volumeChangePercent: -18.0 }]
            }
          }
        }
      }
    };

    const dto = AnalysisSnapshotMapper.map(evalResult, scalperManifest, dummySnapshot);

    // 1. Authentic Strategy Score must be preserved (not clamped to 0)
    expect(dto.marketAnalysis.confidenceScore).toBe(61);
    expect(dto.tradingSignal.type).toBe('HOLD');

    // 2. Indicators must include MACD, Volume MA, RSI, Fast EMA, Slow EMA, ATR
    const indicatorNames = dto.marketAnalysis.indicatorSummary.map(i => i.name);
    expect(indicatorNames).toContain('RSI (14) [15m]');
    expect(indicatorNames).toContain('Fast EMA (9) [15m]');
    expect(indicatorNames).toContain('Slow EMA (21) [15m]');
    expect(indicatorNames).toContain('MACD (12,26,9) [15m]');
    expect(indicatorNames).toContain('Volume MA (20) [15m]');
    expect(indicatorNames).toContain('ATR (14) [15m]');

    // 3. Unused SMAs must be omitted
    expect(indicatorNames).not.toContain('SMA (50) [15m]');
    expect(indicatorNames).not.toContain('SMA (200) [15m]');

    // 4. Checkpoints must be accurately mapped
    expect(dto.marketAnalysis.conditionSummary).toHaveLength(4);
    const trendChk = dto.marketAnalysis.conditionSummary.find(c => c.name.includes('Trend'));
    expect(trendChk?.status).toBe('PASSED');
    expect(trendChk?.currentValue).toBe('Price > EMA(9)');
    expect(trendChk?.targetValue).toBe('EMA(9) > EMA(21)');

    const momChk = dto.marketAnalysis.conditionSummary.find(c => c.name.includes('Momentum'));
    expect(momChk?.status).toBe('FAILED');
  });
});
