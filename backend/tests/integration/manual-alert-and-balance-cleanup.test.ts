import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import BigNumber from 'bignumber.js';
import app, { Env } from '../../src/index';
import { TradingBot, TradeAlert } from '../../src/trading-bot';
import { handleGetTechnicalAnalysis } from '../../src/handlers/exchange';
import { ExchangeManager } from '../../src/exchanges';
import { StrategyOrchestrator } from '../../src/engine/orchestrator/StrategyOrchestrator';
import { DirectionalMtfArbitrator } from '../../src/engine/arbitration/DirectionalMtfArbitrator';
import * as notifications from '../../src/handlers/notifications';

vi.mock('../../src/crypto', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    decrypt: async () => 'mocked_secret_key',
    encrypt: async () => ({ iv: 'iv', encrypted: 'enc', salt: 'salt' }),
    cleanCredential: (c: string) => (c ? c.trim() : c)
  };
});

describe('Manual-Alert Removal & Zero-Wallet-Fallback Cleanup', () => {
  const userId = 'usr_cleanup_test';
  const jwtSecret = 'test-jwt-secret-key-32-chars-long!!';
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockDb: any;
  let mockEnv: any;
  let mockAdapter: any;

  const mockMarkets = [
    {
      id: 'BTCUSDT',
      symbol: 'BTC/USDT',
      base: 'BTC',
      quote: 'USDT',
      active: true,
      category: 'linear',
      contractType: 'LinearPerpetual',
      precision: { price: 0.1, amount: 0.001 },
      limits: {
        amount: { min: 0.001, max: 100 },
        marketAmount: { max: 50 },
        cost: { min: 5 }
      }
    }
  ];

  const makeCandles = (count = 70) =>
    Array.from({ length: count }, (_, i) => ({
      openTime: Date.now() - (count - i) * 60_000,
      timestamp: Date.now() - (count - i) * 60_000,
      open: 50000 + i * 5,
      high: 50020 + i * 5,
      low: 49980 + i * 5,
      close: 50010 + i * 5,
      volume: 100,
      isClosed: true
    }));

  beforeEach(() => {
    vi.restoreAllMocks();
    mockStorage = new Map();

    mockState = {
      id: { toString: () => 'mock-do-cleanup' },
      storage: {
        get: vi.fn(async (keyOrKeys: string | string[]) => {
          if (Array.isArray(keyOrKeys)) {
            const res = new Map();
            for (const k of keyOrKeys) {
              if (mockStorage.has(k)) res.set(k, mockStorage.get(k));
            }
            return res;
          }
          return mockStorage.get(keyOrKeys);
        }),
        put: vi.fn(async (keyOrEntries: string | Record<string, any>, val?: any) => {
          if (typeof keyOrEntries === 'string') {
            mockStorage.set(keyOrEntries, val);
          } else if (keyOrEntries && typeof keyOrEntries === 'object') {
            for (const [k, v] of Object.entries(keyOrEntries)) {
              mockStorage.set(k, v);
            }
          }
        }),
        delete: vi.fn(async (key: string) => mockStorage.delete(key)),
        list: vi.fn(async (opts?: any) => {
          const map = new Map();
          const prefix = opts?.prefix;
          for (const [k, v] of mockStorage.entries()) {
            if (!prefix || k.startsWith(prefix)) map.set(k, v);
          }
          return map;
        }),
        transaction: vi.fn(async (cb: any) => cb(mockState.storage)),
        setAlarm: vi.fn().mockResolvedValue(undefined),
        getAlarm: vi.fn().mockResolvedValue(null),
        deleteAlarm: vi.fn().mockResolvedValue(undefined)
      },
      blockConcurrencyWhile: vi.fn(async (fn: () => Promise<any>) => fn())
    };

    mockDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        const statement = {
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('FROM users')) {
              return {
                exchange_name: 'bybit',
                exchange_environment: 'mainnet',
                exchange_region: 'global',
                exchange_api_key_iv: 'iv',
                exchange_api_key_encrypted: 'enc',
                exchange_api_key_salt: 'salt',
                exchange_api_secret_iv: 'iv',
                exchange_api_secret_encrypted: 'enc',
                exchange_api_secret_salt: 'salt'
              };
            }
            return null;
          }),
          all: vi.fn().mockImplementation(async () => {
            if (sql.includes('PRAGMA table_info')) {
              return { results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] };
            }
            return { results: [] };
          }),
          run: vi.fn().mockResolvedValue({ success: true })
        };
        return {
          bind: vi.fn().mockReturnValue(statement),
          ...statement
        };
      })
    };

    mockAdapter = {
      fetchMarkets: vi.fn().mockResolvedValue(mockMarkets),
      fetchMarket: vi.fn().mockResolvedValue(mockMarkets[0]),
      fetchTickers: vi.fn().mockResolvedValue([
        {
          symbol: 'BTC/USDT',
          last: 50000,
          bid: 49990,
          ask: 50010,
          volume: 1000,
          quoteVolume: 50_000_000,
          high: 51000,
          low: 49000
        }
      ]),
      fetchTicker: vi.fn().mockResolvedValue({
        symbol: 'BTC/USDT',
        last: new BigNumber(50000),
        bid: new BigNumber(49990),
        ask: new BigNumber(50010),
        volume: new BigNumber(1000),
        quoteVolume: new BigNumber(50_000_000),
        high: new BigNumber(51000),
        low: new BigNumber(49000)
      }),
      fetchKlines: vi.fn().mockResolvedValue(makeCandles()),
      fetchCandles: vi.fn().mockResolvedValue(makeCandles()),
      fetchPositions: vi.fn().mockResolvedValue([]),
      fetchBalance: vi.fn().mockResolvedValue([
        { currency: 'USDT', free: new BigNumber(500), total: new BigNumber(500) }
      ]),
      createOrder: vi.fn().mockResolvedValue({ id: 'ord-auto-1', status: 'closed', filled: 0.002, amount: 0.002 })
    };

    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter as any);
    vi.spyOn(DirectionalMtfArbitrator, 'evaluateCandidate').mockReturnValue({
      passed: true,
      gate: 'PASS',
      reasoning: 'Mock passed'
    } as any);
    vi.spyOn(notifications, 'sendTradeNotification').mockResolvedValue({
      success: true,
      outcome: 'DELIVERED',
      httpStatus: 200
    } as any);

    mockEnv = {
      ENVIRONMENT: 'test',
      JWT_SECRET: jwtSecret,
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      COOKIE_ENCRYPTION_KEY: 'test-cookie-key',
      RESEND_API_KEY: 're_test_123456789',
      ALLOWED_ORIGINS: 'https://app.cryptopulse.io',
      GLOBAL_TRADING_HALT: 'false',
      DB: mockDb
    };
  });

  it('1. returns 404 for removed Worker route POST /api/trading-bot/manual-alert without invoking Durable Object', async () => {
    const botFetchSpy = vi.fn();
    const envWithDo = {
      ...mockEnv,
      TRADING_BOTS: {
        idFromName: vi.fn().mockReturnValue('mock-bot-id'),
        get: vi.fn().mockReturnValue({ fetch: botFetchSpy })
      }
    };

    const token = await sign(
      { sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 },
      jwtSecret,
      'HS256'
    );

    const res = await app.request(
      '/api/trading-bot/manual-alert',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Origin: 'https://app.cryptopulse.io'
        },
        body: JSON.stringify({ symbol: 'BTC/USDT', strategy: 'ScalperV2' })
      },
      envWithDo
    );

    expect(res.status).toBe(404);
    expect(botFetchSpy).not.toHaveBeenCalled();
  });

  it('2. returns 404 for removed Durable Object endpoint POST /register-alert', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    const res = await bot.fetch(
      new Request('http://bot/register-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alert: {
            id: 'manual-alert-1',
            symbol: 'BTC/USDT',
            side: 'BUY',
            status: 'pending'
          }
        })
      })
    );

    expect(res.status).toBe(404);
  });

  it('3. fails closed with 409 INVALID_ALERT_PROVENANCE and zero order dispatch for any persisted legacy MANUAL alert', async () => {
    mockStorage.set('userId', userId);
    mockStorage.set('isActive', true);
    mockStorage.set('lock:alarmGeneration', 1);
    mockStorage.set('approvedCandidateRecord', {
      approvalGeneration: 1,
      userId,
      budgetUsdt: 100,
      approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
      approvalState: 'FINAL_APPROVED',
      exchangeName: 'bybit',
      environment: 'mainnet',
      accountFingerprint: 'bybit:mainnet',
      orderType: 'ALL',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      symbolMetadataSnapshot: {}
    });
    mockStorage.set('alerts', [
      {
        id: 'legacy-manual-alert',
        symbol: 'BTC/USDT',
        signalPrice: 50000,
        targetEntryPrice: 50000,
        entryPrice: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        positionSize: 100,
        quantity: 0.002,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        source: 'MANUAL',
        generation: 1,
        approvalGeneration: 1
      }
    ]);

    const orderSpy = vi.spyOn(ExchangeManager, 'executeIdempotentOrder');
    const bot = new TradingBot(mockState, mockEnv);

    const execRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, alertId: 'legacy-manual-alert' })
      })
    );

    expect(execRes.status).toBe(409);
    const body = await execRes.json<any>();
    expect(body.success).toBe(false);
    expect(body.code).toBe('INVALID_ALERT_PROVENANCE');
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it('4. handleGetTechnicalAnalysis resolves throwing or zero wallet balance to 0 (never $1,000) while preserving preview signal output', async () => {
    const realBot = new TradingBot(mockState, mockEnv);
    mockStorage.set('approvedCandidateRecord', {
      approvalGeneration: 1,
      userId,
      budgetUsdt: 100,
      approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
      approvalState: 'FINAL_APPROVED',
      exchangeName: 'bybit',
      environment: 'mainnet',
      accountFingerprint: 'bybit:mainnet',
      orderType: 'MARKET',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      symbolMetadataSnapshot: {}
    });

    const executeCycleSpy = vi
      .spyOn(StrategyOrchestrator.prototype, 'executeCycle')
      .mockResolvedValue([
        {
          strategyId: 'ScalperV2',
          timestamp: Date.now(),
          confidenceScore: 86,
          hasSignal: true,
          metadata: {
            targetTimeframe: '5m',
            signal: {
              type: 'BUY',
              signalPrice: 50000,
              stopLoss: 49500,
              takeProfit: 51000,
              timeframe: '5m'
            }
          }
        } as any
      ]);

    const testApp = new Hono<{ Bindings: Env; Variables: { jwtPayload: { sub: string } } }>();
    testApp.use('*', async (c, next) => {
      c.set('jwtPayload', { sub: userId });
      await next();
    });
    testApp.post('/api/market/technical-analysis', handleGetTechnicalAnalysis);

    const envWithDo = {
      ...mockEnv,
      TRADING_BOTS: {
        idFromName: vi.fn().mockReturnValue('mock-bot-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockImplementation((req: Request) => realBot.fetch(req))
        })
      }
    };

    // Case A: fetchBalance throws
    mockAdapter.fetchBalance.mockRejectedValueOnce(new Error('Exchange balance endpoint timeout'));
    const resErr = await testApp.request(
      '/api/market/technical-analysis',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTC/USDT', strategy: 'ScalperV2', approvalGeneration: 1 })
      },
      envWithDo
    );

    expect(resErr.status).toBe(200);
    const dtoErr = await resErr.json<any>();
    expect(dtoErr.strategy).toBe('ScalperV2');
    expect(executeCycleSpy).toHaveBeenCalledTimes(1);
    expect(executeCycleSpy.mock.calls[0][3]).toBe(0);

    // Case B: fetchBalance returns empty / zero USDT
    mockAdapter.fetchBalance.mockResolvedValueOnce([]);
    const resZero = await testApp.request(
      '/api/market/technical-analysis',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTC/USDT', strategy: 'ScalperV2', approvalGeneration: 1 })
      },
      envWithDo
    );

    expect(resZero.status).toBe(200);
    const dtoZero = await resZero.json<any>();
    expect(dtoZero.strategy).toBe('ScalperV2');
    expect(executeCycleSpy).toHaveBeenCalledTimes(2);
    expect(executeCycleSpy.mock.calls[1][3]).toBe(0);
  });

  it('5. preserves end-to-end autonomous pipeline: alarm() -> AUTONOMOUS TradeAlert -> FCM -> /execute-trade', async () => {
    mockStorage.set('userId', userId);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('isActive', true);
    mockStorage.set('coinId', 'BTC/USDT');
    mockStorage.set('monitoredSymbols', ['BTC/USDT']);
    mockStorage.set('positionSize', 100);
    mockStorage.set('lock:alarmGeneration', 1);
    mockStorage.set('approvedCandidateRecord', {
      approvalGeneration: 1,
      userId,
      budgetUsdt: 100,
      approvedSymbols: ['BTC', 'BTCUSDT', 'BTC/USDT'],
      approvalState: 'FINAL_APPROVED',
      exchangeName: 'bybit',
      environment: 'mainnet',
      accountFingerprint: 'bybit:mainnet',
      orderType: 'MARKET',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      symbolMetadataSnapshot: {}
    });

    vi.spyOn(StrategyOrchestrator.prototype, 'executeCycle').mockResolvedValueOnce([
      {
        strategyId: 'ScalperV2',
        timestamp: Date.now(),
        confidenceScore: 91,
        hasSignal: true,
        metadata: {
          targetTimeframe: '5m',
          signal: {
            type: 'BUY',
            signalPrice: 50000,
            stopLoss: 49500,
            takeProfit: 51000,
            timeframe: '5m'
          }
        }
      } as any
    ]);

    const orderSpy = vi
      .spyOn(ExchangeManager, 'executeIdempotentOrder')
      .mockResolvedValueOnce({
        orderId: 'exec-auto-1',
        status: 'FILLED',
        price: 50000,
        executedQty: 0.002
      } as any);

    const bot = new TradingBot(mockState, mockEnv);
    vi.spyOn(bot as any, 'monitorOpenPositions').mockResolvedValue(undefined);

    await bot.alarm();

    const alerts = (mockStorage.get('alerts') || []) as TradeAlert[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].source).toBe('AUTONOMOUS');
    expect(alerts[0].generation).toBe(1);
    expect(alerts[0].approvalGeneration).toBe(1);
    expect(alerts[0].isExecutable).toBe(true);
    expect(alerts[0].positionSize).toBe(100);
    expect(alerts[0].quantity).toBe(0.002);
    expect(notifications.sendTradeNotification).toHaveBeenCalledTimes(1);

    mockAdapter.fetchPositions.mockResolvedValue([
      { symbol: 'BTC/USDT', contracts: 0, size: 0, positionIdx: 0, side: 'long' }
    ]);

    const execRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          alertId: alerts[0].id,
          entryIntent: 'IMMEDIATE'
        })
      })
    );

    expect(execRes.status).toBe(200);
    const execBody = await execRes.json<any>();
    expect(execBody.success).toBe(true);
    expect(orderSpy).toHaveBeenCalledTimes(1);
    const orderReq = orderSpy.mock.calls[0][1] as any;
    expect(orderReq.symbol).toBe('BTC/USDT');
    expect(Number(orderReq.amount ?? orderReq.quantity)).toBe(0.002);
  });
});
