import { describe, it, expect } from 'vitest';
import { EngineStatusDTO, MarketAnalysisDTO, SignalDTO, AndroidIntegrationContract, StrategyDiscoveryResponseDTO } from './index';

describe('Android API Contracts', () => {
  it('should successfully serialize StrategyDiscoveryResponseDTO', () => {
    const dto: StrategyDiscoveryResponseDTO = {
      version: '2.0',
      count: 1,
      strategies: [
        {
          id: 'TestStrategy',
          displayName: 'Test',
          description: 'A test strategy',
          version: '1.0.0',
          category: 'Test',
          riskProfile: 'Low',
          supportedMarkets: ['CRYPTO'],
          supportedTimeframes: ['5m'],
          minimumCandles: 10,
          defaultConfiguration: {},
          supportsLong: true,
          supportsShort: false,
          supportsPaperTrading: true,
          supportsLiveTrading: false,
          status: 'EXPERIMENTAL',
          author: 'Test'
        }
      ]
    };

    const json = JSON.stringify(dto);
    const parsed = JSON.parse(json) as StrategyDiscoveryResponseDTO;

    expect(parsed.version).toBe('2.0');
    expect(parsed.count).toBe(1);
    expect(parsed.strategies[0].id).toBe('TestStrategy');
    expect(parsed.strategies[0].status).toBe('EXPERIMENTAL');
  });

  it('should successfully serialize EngineStatusDTO', () => {
    const dto: EngineStatusDTO = {
      state: 'EVALUATING',
      activeStrategy: 'ScalperV2',
      lastEvaluationTimestamp: 162989182,
      nextEvaluationTime: null,
      health: 'OK'
    };

    const json = JSON.stringify(dto);
    const parsed = JSON.parse(json) as EngineStatusDTO;

    expect(parsed.state).toBe('EVALUATING');
    expect(parsed.health).toBe('OK');
  });

  it('should successfully serialize MarketAnalysisDTO', () => {
    const dto: MarketAnalysisDTO = {
      symbol: 'BTC/USDT',
      timeframeStatus: 'SYNCED',
      indicatorSummary: [
        { name: 'RSI(14)', value: '65', signal: 'BULLISH' }
      ],
      conditionSummary: [
        { id: 'c1', name: 'Price > EMA', currentValue: '50000', targetValue: '> 49000', status: 'PASSED' }
      ],
      confidenceScore: 85,
      confidenceExplanation: ['Trend is strong']
    };

    const json = JSON.stringify(dto);
    const parsed = JSON.parse(json) as MarketAnalysisDTO;

    expect(parsed.symbol).toBe('BTC/USDT');
    expect(parsed.indicatorSummary[0].signal).toBe('BULLISH');
    expect(parsed.conditionSummary[0].status).toBe('PASSED');
  });

  it('should successfully serialize SignalDTO', () => {
    const dto: SignalDTO = {
      type: 'BUY',
      entryContext: 'Price broke resistance',
      stopLoss: 49000,
      takeProfit: 52000,
      riskClassification: 'LOW',
      reasoning: ['Conditions met']
    };

    const json = JSON.stringify(dto);
    const parsed = JSON.parse(json) as SignalDTO;

    expect(parsed.type).toBe('BUY');
    expect(parsed.stopLoss).toBe(49000);
  });

  it('should successfully serialize AndroidIntegrationContract', () => {
    const contract: AndroidIntegrationContract = {
      engineStatus: {
        state: 'EVALUATING',
        activeStrategy: 'ScalperV2',
        lastEvaluationTimestamp: 162989182,
        nextEvaluationTime: null,
        health: 'OK'
      },
      marketAnalysis: {
        symbol: 'BTC/USDT',
        timeframeStatus: 'SYNCED',
        indicatorSummary: [],
        conditionSummary: [],
        confidenceScore: 0,
        confidenceExplanation: []
      },
      tradingSignal: {
        type: 'HOLD',
        entryContext: '',
        stopLoss: null,
        takeProfit: null,
        riskClassification: 'LOW',
        reasoning: []
      }
    };

    const json = JSON.stringify(contract);
    const parsed = JSON.parse(json) as AndroidIntegrationContract;

    expect(parsed.engineStatus.state).toBe('EVALUATING');
    expect(parsed.tradingSignal.type).toBe('HOLD');
  });
});
