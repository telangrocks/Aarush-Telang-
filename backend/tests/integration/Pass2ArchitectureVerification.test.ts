import { describe, it, expect, vi, beforeEach } from 'vitest';
import BigNumber from 'bignumber.js';
import { TradingBot } from '../../src/trading-bot';
import { ExchangeManager } from '../../src/exchanges';
import { StrategyRegistry } from '../../src/engine/strategies/StrategyRegistry';
import { StrategyOrchestrator } from '../../src/engine/orchestrator/StrategyOrchestrator';
import { MarketRegimeEngine } from '../../src/engine/regime/MarketRegimeEngine';
import { sendTradeNotification } from '../../src/handlers/notifications';
import { ScalperV2Strategy } from '../../src/engine/strategies/scalper-v2/ScalperV2Strategy';
import { MomentumStrategy } from '../../src/engine/strategies/momentum/MomentumStrategy';
import { BreakoutStrategy } from '../../src/engine/strategies/breakout/BreakoutStrategy';
import { MeanReversionStrategy } from '../../src/engine/strategies/mean-reversion/MeanReversionStrategy';
import { VWAPStrategy } from '../../src/engine/strategies/vwap/VWAPStrategy';
import { StrategyContext } from '../../src/engine/context/StrategyContext';
import { MarketSnapshot, NormalizedCandle } from '../../src/engine/market-data/MarketSnapshot';
import { Timeframe } from '../../src/engine/market-data/Timeframe';

// Mock crypto
vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mock_decrypted_secret'),
  encrypt: vi.fn().mockResolvedValue({ iv: 'iv', encrypted: 'enc', salt: 'salt' }),
  cleanCredential: vi.fn().mockImplementation((k: any) => k),
}));

// Mock notifications
vi.mock('../../src/handlers/notifications', () => ({
  sendTradeNotification: vi.fn().mockResolvedValue({ success: true }),
}));

function createSyntheticCandles(count = 35, basePrice = 100, intervalMs = 300000): NormalizedCandle[] {
  const now = 1789000000000;
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < count; i++) {
    const openTime = now - (count - i) * intervalMs;
    const p = basePrice + i * 0.5;
    candles.push({
      timestamp: openTime,
      openTime,
      open: p - 0.5,
      high: p + 1.0,
      low: p - 1.0,
      close: p,
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

function createSyntheticSnapshot(symbol = 'BTC/USDT', price = 50000): MarketSnapshot {
  return {
    symbol,
    timestamp: 1789000000000,
    currentPrice: price,
    volume24h: 1000000,
    quoteVolume24h: 50000000,
    candles: {
      '1m': [],
      '3m': [],
      '5m': createSyntheticCandles(50, price, 300000),
      '15m': createSyntheticCandles(50, price, 900000),
      '30m': [],
      '1h': createSyntheticCandles(50, price, 3600000),
      '4h': createSyntheticCandles(50, price, 14400000),
    },
    metadata: {
      priceChange24h: 100,
      priceChangePercent24h: 0.2,
      highPrice24h: price * 1.05,
      lowPrice24h: price * 0.95,
    },
  };
}

describe('Pass 2 Architecture Verification: Independent Timeframe Pipelines', () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockDb: any;
  let mockEnv: any;
  let dbQueries: { query: string; params: any[] }[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = new Map<string, any>();
    dbQueries = [];

    mockState = {
      id: { toString: () => 'pass2-test-do-id' },
      storage: {
        get: vi.fn().mockImplementation(async (keyOrKeys: string | string[]) => {
          if (Array.isArray(keyOrKeys)) {
            const m = new Map();
            for (const k of keyOrKeys) {
              if (mockStorage.has(k)) m.set(k, mockStorage.get(k));
            }
            return m;
          }
          return mockStorage.get(keyOrKeys);
        }),
        put: vi.fn().mockImplementation(async (keyOrEntries: string | Record<string, any>, val?: any) => {
          if (typeof keyOrEntries === 'string') {
            mockStorage.set(keyOrEntries, val);
          } else if (keyOrEntries && typeof keyOrEntries === 'object') {
            for (const [k, v] of Object.entries(keyOrEntries)) {
              mockStorage.set(k, v);
            }
          }
        }),
        delete: vi.fn().mockImplementation(async (key: string) => {
          mockStorage.delete(key);
        }),
        list: vi.fn().mockImplementation(async (options?: any) => {
          const prefix = options?.prefix || '';
          const result = new Map();
          for (const [k, v] of mockStorage.entries()) {
            if (k.startsWith(prefix)) result.set(k, v);
          }
          return result;
        }),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          await cb({
            get: async (k: string) => mockStorage.get(k),
            put: async (k: string, v: any) => mockStorage.set(k, v),
            delete: async (k: string) => mockStorage.delete(k),
          });
        }),
        setAlarm: vi.fn(),
        deleteAlarm: vi.fn(),
      },
      blockConcurrencyWhile: vi.fn().mockImplementation(async (fn: any) => fn()),
    };

    mockDb = {
      prepare: vi.fn().mockImplementation((query: string) => {
        if (query.includes("PRAGMA table_info('trade_positions')")) {
          return {
            all: vi.fn().mockResolvedValue({
              results: [
                { name: 'target_entry_price' },
                { name: 'entry_status' },
                { name: 'timeframe' },
              ],
            }),
          };
        }
        return {
          bind: vi.fn().mockImplementation((...args: any[]) => {
            dbQueries.push({ query, params: args });
            return {
              run: vi.fn().mockResolvedValue({ success: true }),
              first: vi.fn().mockImplementation(async () => {
                if (query.includes('FROM users')) {
                  return {
                    exchange_name: 'bybit',
                    exchange_environment: 'demo',
                    exchange_region: 'global',
                    exchange_api_key: 'test_api_key',
                    exchange_api_secret_encrypted: 'mock_encrypted_secret',
                    exchange_api_secret_iv: 'mock_iv',
                    exchange_api_secret_salt: 'mock_salt',
                  };
                }
                return null;
              }),
              all: vi.fn().mockResolvedValue({ results: [] }),
            };
          }),
        };
      }),
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: 'test_encryption_key',
      GLOBAL_TRADING_HALT: 'false',
    };

    // Mock exchange provider with full interface compliance
    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
      fetchTicker: vi.fn().mockResolvedValue({
        symbol: 'BTCUSDT',
        last: 50000,
        bid: 49999,
        ask: 50001,
      }),
      fetchBalance: vi.fn().mockResolvedValue({
        free: { USDT: 10000 },
        total: { USDT: 10000 },
      }),
      fetchKlines: vi.fn().mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => ({
          openTime: Date.now() - (30 - i) * 3600000,
          open: 49900 + i * 10,
          high: 50100 + i * 10,
          low: 49800 + i * 10,
          close: 50000 + i * 10,
          volume: 500,
        }))
      ),
      fetchMarkets: vi.fn().mockResolvedValue([
        {
          id: 'BTCUSDT',
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          category: 'linear',
          contractType: 'LinearPerpetual',
          precision: { price: 0.1, amount: 0.001 },
          limits: {
            price: { min: new BigNumber(0.1), max: new BigNumber(1000000) },
            amount: { min: new BigNumber(0.001), max: new BigNumber(100) },
            cost: { min: new BigNumber(5) },
          },
        },
      ]),
      createOrder: vi.fn().mockImplementation(async (req: any) => ({
        id: 'ord-bybit-pass2-123',
        symbol: req.symbol,
        amount: req.amount,
        status: 'closed',
        filled: { toNumber: () => 1.0 },
        average: { toNumber: () => 50000.0 },
      })),
      fetchPositions: vi.fn().mockResolvedValue([]),
    } as any);

    vi.spyOn(ExchangeManager, 'executeIdempotentOrder').mockImplementation(async (provider: any, req: any) => {
      return provider.createOrder(req);
    });
  });

  // =========================================================================
  // Test 1: Multi-Timeframe Concurrent Execution Across Manifest Timeframes
  // =========================================================================
  it('1. StrategyOrchestrator executes each strategy strictly across its manifest-declared timeframes', async () => {
    const orchestrator = new StrategyOrchestrator();
    const snapshot = createSyntheticSnapshot('BTC/USDT');

    const mockMarketDataEngine: any = {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
    };
    orchestrator.setMarketDataEngine(mockMarketDataEngine);

    const registry = StrategyRegistry.getInstance();
    const scalper = registry.getStrategy('scalper-v2')!;
    const momentum = registry.getStrategy('momentum')!;
    const breakout = registry.getStrategy('breakout')!;
    const meanReversion = registry.getStrategy('mean-reversion')!;
    const vwap = registry.getStrategy('vwap')!;

    const scalperSpy = vi.spyOn(scalper, 'evaluate');
    const momentumSpy = vi.spyOn(momentum, 'evaluate');
    const breakoutSpy = vi.spyOn(breakout, 'evaluate');
    const meanReversionSpy = vi.spyOn(meanReversion, 'evaluate');
    const vwapSpy = vi.spyOn(vwap, 'evaluate');

    await orchestrator.executeCycle('BTC/USDT');

    // ScalperV2: ['5m', '15m', '1h', '4h']
    expect(scalperSpy).toHaveBeenCalledWith(expect.anything(), '5m');
    expect(scalperSpy).toHaveBeenCalledWith(expect.anything(), '15m');
    expect(scalperSpy).toHaveBeenCalledWith(expect.anything(), '1h');
    expect(scalperSpy).toHaveBeenCalledWith(expect.anything(), '4h');

    // Momentum: ['5m', '15m', '1h', '4h']
    expect(momentumSpy).toHaveBeenCalledWith(expect.anything(), '5m');
    expect(momentumSpy).toHaveBeenCalledWith(expect.anything(), '15m');
    expect(momentumSpy).toHaveBeenCalledWith(expect.anything(), '1h');
    expect(momentumSpy).toHaveBeenCalledWith(expect.anything(), '4h');

    // Breakout: ['5m', '15m', '1h', '4h']
    expect(breakoutSpy).toHaveBeenCalledWith(expect.anything(), '5m');
    expect(breakoutSpy).toHaveBeenCalledWith(expect.anything(), '15m');
    expect(breakoutSpy).toHaveBeenCalledWith(expect.anything(), '1h');
    expect(breakoutSpy).toHaveBeenCalledWith(expect.anything(), '4h');

    // MeanReversion: ['5m', '15m', '1h', '4h']
    expect(meanReversionSpy).toHaveBeenCalledWith(expect.anything(), '5m');
    expect(meanReversionSpy).toHaveBeenCalledWith(expect.anything(), '15m');
    expect(meanReversionSpy).toHaveBeenCalledWith(expect.anything(), '1h');
    expect(meanReversionSpy).toHaveBeenCalledWith(expect.anything(), '4h');

    // VWAP: ['15m', '1h', '4h'] ONLY — MUST NOT execute on 5m!
    expect(vwapSpy).toHaveBeenCalledWith(expect.anything(), '15m');
    expect(vwapSpy).toHaveBeenCalledWith(expect.anything(), '1h');
    expect(vwapSpy).toHaveBeenCalledWith(expect.anything(), '4h');
    const vwapTimeframeCalls = vwapSpy.mock.calls.map((call) => call[1]);
    expect(vwapTimeframeCalls).not.toContain('5m');

    // Manifest single source of truth: 1m, 3m, 30m are never executed
    const allSpies = [scalperSpy, momentumSpy, breakoutSpy, meanReversionSpy, vwapSpy];
    for (const spy of allSpies) {
      const calls = spy.mock.calls.map((c) => c[1]);
      expect(calls).not.toContain('1m');
      expect(calls).not.toContain('3m');
      expect(calls).not.toContain('30m');
    }
  });

  // =========================================================================
  // Test 2: Deduplication Independence Across Timeframes
  // =========================================================================
  it('2. Deduplication keys on (symbol, strategy, timeframe): 5m and 15m alerts do not collide', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // Seed existing active 5m alert
    const existing5mAlert = {
      id: 'existing-btc-5m-alert',
      symbol: 'BTC/USDT',
      strategy: 'scalper-v2_NEW',
      timeframe: '5m' as const,
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      positionSize: 100,
      side: 'BUY' as const,
      timestamp: new Date().toISOString(),
      status: 'pending' as const,
    };

    mockStorage.set('isActive', true);
    mockStorage.set('userId', 'user-test-dedup');
    mockStorage.set('strategy', 'scalper-v2');
    mockStorage.set('positionSize', 100);
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    mockStorage.set('alerts', [existing5mAlert]);

    // Mock executeCycle to emit both 5m and 15m BUY signals
    const { StrategyOrchestrator: MockOrchestrator } = await import('../../src/engine/orchestrator/StrategyOrchestrator');
    vi.spyOn(MockOrchestrator.prototype, 'executeCycle').mockResolvedValue([
      {
        strategyId: 'scalper-v2',
        confidenceScore: 85,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 49000,
            takeProfit: 52000,
            timeframe: '5m',
            riskAssessment: { positionSizeRecommendation: 100 },
          },
        },
      },
      {
        strategyId: 'scalper-v2',
        confidenceScore: 90,
        hasSignal: true,
        metadata: {
          targetTimeframe: '15m',
          signal: {
            type: 'BUY',
            signalPrice: 50200,
            stopLoss: 49200,
            takeProfit: 52500,
            timeframe: '15m',
            riskAssessment: { positionSizeRecommendation: 100 },
          },
        },
      },
    ]);

    await bot.alarm();

    const alerts = mockStorage.get('alerts');
    expect(alerts).toBeDefined();
    // 5m signal was deduplicated against existing-btc-5m-alert, but 15m signal generated a new alert!
    expect(alerts.length).toBe(2);
    expect(alerts[0].id).toBe('existing-btc-5m-alert');
    expect(alerts[0].timeframe).toBe('5m');

    expect(alerts[1].symbol).toBe('BTC/USDT');
    expect(alerts[1].timeframe).toBe('15m');
    expect(alerts[1].status).toBe('pending');
  });

  // =========================================================================
  // Test 3: FCM Notification Payload Contains Timeframe
  // =========================================================================
  it('3. Dispatched trade notification contains the originating target timeframe', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set('isActive', true);
    mockStorage.set('userId', 'user-test-fcm');
    mockStorage.set('strategy', 'momentum');
    mockStorage.set('positionSize', 100);
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    mockStorage.set('alerts', []);

    const { StrategyOrchestrator: MockOrchestrator } = await import('../../src/engine/orchestrator/StrategyOrchestrator');
    vi.spyOn(MockOrchestrator.prototype, 'executeCycle').mockResolvedValue([
      {
        strategyId: 'momentum',
        confidenceScore: 88,
        hasSignal: true,
        metadata: {
          targetTimeframe: '1h',
          signal: {
            type: 'BUY',
            signalPrice: 50500,
            stopLoss: 49500,
            takeProfit: 53000,
            timeframe: '1h',
            riskAssessment: { positionSizeRecommendation: 100 },
          },
        },
      },
    ]);

    await bot.alarm();

    expect(sendTradeNotification).toHaveBeenCalled();
    const notificationCall = vi.mocked(sendTradeNotification).mock.calls[0];
    const opportunityArg = notificationCall[3];
    expect(opportunityArg.timeframe).toBe('1h');
    expect(opportunityArg.symbol).toBe('BTC/USDT');
  });

  // =========================================================================
  // Test 4: /execute-trade Persists Timeframe into WAL EconomicIntent
  // =========================================================================
  it('4. /execute-trade writes timeframe into WAL EconomicIntent in DO storage', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertId = 'alert-wal-tf-test';

    const tradeAlert = {
      id: alertId,
      symbol: 'BTC/USDT',
      strategy: 'scalper-v2',
      timeframe: '15m' as const,
      side: 'BUY' as const,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      signalPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      positionSize: 100,
      status: 'pending' as const,
      timestamp: new Date().toISOString(),
    };

    mockStorage.set('userId', 'user-wal-test');
    mockStorage.set('strategy', 'scalper-v2');
    mockStorage.set('alerts', [tradeAlert]);

    let capturedWalIntent: any = null;
    const origPut = mockState.storage.put;
    mockState.storage.put = vi.fn().mockImplementation(async (k: any, v?: any) => {
      if (typeof k === 'string' && k.startsWith('intent:order:')) {
        capturedWalIntent = v;
      }
      return origPut(k, v);
    });

    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId }),
    });

    const execRes = await bot.fetch(execReq);
    expect(execRes.status).toBe(200);

    // Verify WAL intent captured during dispatch
    expect(capturedWalIntent).not.toBeNull();
    expect(capturedWalIntent.timeframe).toBe('15m');
    expect(capturedWalIntent.symbol).toBe('BTC/USDT');
  });

  // =========================================================================
  // Test 5: /execute-trade Persists Timeframe into D1 trade_positions
  // =========================================================================
  it('5. /execute-trade persists timeframe column and value into D1 trade_positions', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertId = 'alert-d1-positions-test';

    const tradeAlert = {
      id: alertId,
      symbol: 'BTC/USDT',
      strategy: 'scalper-v2',
      timeframe: '1h' as const,
      side: 'BUY' as const,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      signalPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      positionSize: 100,
      status: 'pending' as const,
      timestamp: new Date().toISOString(),
    };

    mockStorage.set('userId', 'user-d1-positions-test');
    mockStorage.set('strategy', 'scalper-v2');
    mockStorage.set('alerts', [tradeAlert]);

    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId }),
    });

    const execRes = await bot.fetch(execReq);
    expect(execRes.status).toBe(200);

    // Find INSERT query for trade_positions
    const positionQuery = dbQueries.find((q) => q.query.includes('INSERT OR IGNORE INTO trade_positions'));
    expect(positionQuery).toBeDefined();
    expect(positionQuery!.query).toContain('timeframe');
    // Parameter 28 (last parameter of the 28 bind variables) is positionData.timeframe
    const boundTimeframe = positionQuery!.params[positionQuery!.params.length - 1];
    expect(boundTimeframe).toBe('1h');
  });

  // =========================================================================
  // Test 6: /execute-trade Persists Timeframe into D1 trade_execution_audit
  // =========================================================================
  it('6. /execute-trade persists timeframe column and value into D1 trade_execution_audit', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertId = 'alert-d1-audit-test';

    const tradeAlert = {
      id: alertId,
      symbol: 'BTC/USDT',
      strategy: 'scalper-v2',
      timeframe: '4h' as const,
      side: 'BUY' as const,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      signalPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      positionSize: 100,
      status: 'pending' as const,
      timestamp: new Date().toISOString(),
    };

    mockStorage.set('userId', 'user-d1-audit-test');
    mockStorage.set('strategy', 'scalper-v2');
    mockStorage.set('alerts', [tradeAlert]);

    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId }),
    });

    const execRes = await bot.fetch(execReq);
    expect(execRes.status).toBe(200);

    // Find INSERT query for trade_execution_audit
    const auditQuery = dbQueries.find((q) => q.query.includes('INSERT INTO trade_execution_audit'));
    expect(auditQuery).toBeDefined();
    expect(auditQuery!.query).toContain('timeframe');
    // Parameter 15 is positionData.timeframe
    const boundTimeframe = auditQuery!.params[auditQuery!.params.length - 1];
    expect(boundTimeframe).toBe('4h');
  });

  // =========================================================================
  // Test 7: Unsupported Timeframes Fail Closed
  // =========================================================================
  it('7. Evaluating an unsupported timeframe fails closed with score=0 and rejection reason', () => {
    const snapshot = createSyntheticSnapshot('BTC/USDT');
    const context = new StrategyContext(snapshot, 1000).freeze();

    const vwap = new VWAPStrategy();
    const scalper = new ScalperV2Strategy();
    const momentum = new MomentumStrategy();
    const breakout = new BreakoutStrategy();
    const meanReversion = new MeanReversionStrategy();

    // VWAP on 5m: must fail closed (manifest is ['15m', '1h', '4h'])
    const vwap5m = vwap.evaluate(context, '5m' as Timeframe);
    expect(vwap5m.hasSignal).toBe(false);
    expect(vwap5m.confidenceScore).toBe(0);
    expect(vwap5m.metadata.reasoning.some((r: string) => r.includes('Unsupported timeframe 5m'))).toBe(true);

    // ScalperV2 on 1m
    const scalper1m = scalper.evaluate(context, '1m' as Timeframe);
    expect(scalper1m.hasSignal).toBe(false);
    expect(scalper1m.confidenceScore).toBe(0);
    expect(scalper1m.metadata.reasoning.some((r: string) => r.includes('Unsupported timeframe 1m'))).toBe(true);

    // Momentum on 3m
    const momentum3m = momentum.evaluate(context, '3m' as Timeframe);
    expect(momentum3m.hasSignal).toBe(false);
    expect(momentum3m.confidenceScore).toBe(0);
    expect(momentum3m.metadata.reasoning.some((r: string) => r.includes('Unsupported timeframe 3m'))).toBe(true);

    // Breakout on 30m
    const breakout30m = breakout.evaluate(context, '30m' as Timeframe);
    expect(breakout30m.hasSignal).toBe(false);
    expect(breakout30m.confidenceScore).toBe(0);
    expect(breakout30m.metadata.reasoning.some((r: string) => r.includes('Unsupported timeframe 30m'))).toBe(true);

    // MeanReversion on 1m
    const meanRev1m = meanReversion.evaluate(context, '1m' as Timeframe);
    expect(meanRev1m.hasSignal).toBe(false);
    expect(meanRev1m.confidenceScore).toBe(0);
    expect(meanRev1m.metadata.reasoning.some((r: string) => r.includes('Unsupported timeframe 1m'))).toBe(true);
  });

  // =========================================================================
  // Test 8: MarketRegime Decoupling
  // =========================================================================
  it('8. MarketRegime evaluate emits telemetry without vetoing autonomous alerts', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set('isActive', true);
    mockStorage.set('userId', 'user-regime-test');
    mockStorage.set('strategy', 'scalper-v2');
    mockStorage.set('positionSize', 100);
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    mockStorage.set('alerts', []);

    // Simulate unfavorable market regime and strategy not allowed
    vi.spyOn(MarketRegimeEngine, 'evaluate').mockReturnValue({
      regime: 'SIDEWAYS_HIGH_VOL' as any,
      score: 30,
      dominantDirection: 'DOWN',
      symbol: 'BTC/USDT',
    } as any);

    vi.spyOn(MarketRegimeEngine, 'isStrategyAllowed').mockReturnValue({
      allowed: false,
      reason: 'Incompatible high volatility sideways regime',
    });

    const { StrategyOrchestrator: MockOrchestrator } = await import('../../src/engine/orchestrator/StrategyOrchestrator');
    vi.spyOn(MockOrchestrator.prototype, 'executeCycle').mockResolvedValue([
      {
        strategyId: 'scalper-v2',
        confidenceScore: 85,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 49000,
            takeProfit: 52000,
            timeframe: '5m',
            riskAssessment: { positionSizeRecommendation: 100 },
          },
        },
      },
    ]);

    await bot.alarm();

    // Alert was generated despite MarketRegime returning allowed: false
    const alerts = mockStorage.get('alerts');
    expect(alerts).toBeDefined();
    expect(alerts.length).toBe(1);
    expect(alerts[0].symbol).toBe('BTC/USDT');
    expect(alerts[0].status).toBe('pending');
  });
});
