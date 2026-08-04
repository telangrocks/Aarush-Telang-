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
    expect(dto.opportunity?.side).toBe('LONG');
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
    expect(dto.marketAnalysis.indicatorSummary).toEqual([]);
    expect(dto.marketAnalysis.conditionSummary).toEqual([]);
    expect(dto.tradingSignal.type).toBe('HOLD');
    expect(dto.opportunity).toBeNull();
  });
});
