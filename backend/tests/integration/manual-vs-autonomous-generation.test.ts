import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradingBot, TradeAlert } from '../../src/trading-bot';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mocked_secret_key')
}));

vi.mock('../../src/exchanges', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', last: 50100, bid: 50090, ask: 50110 }),
        fetchKlines: vi.fn().mockResolvedValue([]),
        fetchBalance: vi.fn().mockResolvedValue([]),
        fetchMarkets: vi.fn().mockResolvedValue([]),
        createOrder: vi.fn().mockResolvedValue({ id: 'ord-123', status: 'closed', filled: { toNumber: () => 0.02 }, amount: { toNumber: () => 0.02 }, average: { toNumber: () => 50100 } }),
        supportsOco: vi.fn().mockReturnValue(false),
        createOcoOrder: vi.fn()
      }),
      executeIdempotentOrder: vi.fn().mockResolvedValue({ id: 'ord-123', status: 'closed', filled: { toNumber: () => 0.02 }, amount: { toNumber: () => 0.02 }, average: { toNumber: () => 50100 } }),
      executeIdempotentOcoOrder: vi.fn()
    },
    normalizeEnvironment: vi.fn().mockReturnValue('testnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

describe('Manual vs Autonomous Alert Generation Lineage', () => {
  let mockState: any;
  let mockStorage: Map<string, any>;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    mockStorage = new Map<string, any>();

    mockState = {
      storage: {
        get: vi.fn(async (key: string | string[]) => {
          if (Array.isArray(key)) {
            const map = new Map();
            key.forEach((k) => {
              if (mockStorage.has(k)) map.set(k, mockStorage.get(k));
            });
            return map;
          }
          return mockStorage.get(key);
        }),
        put: vi.fn(async (key: string | Record<string, any>, value?: any) => {
          if (typeof key === 'string') {
            mockStorage.set(key, value);
          } else {
            Object.entries(key).forEach(([k, v]) => mockStorage.set(k, v));
          }
        }),
        delete: vi.fn(async (key: string | string[]) => {
          if (Array.isArray(key)) {
            key.forEach((k) => mockStorage.delete(k));
          } else {
            mockStorage.delete(key);
          }
        }),
        transaction: vi.fn(async (closure: any) => {
          return await closure({
            get: async (k: string) => mockStorage.get(k),
            put: async (k: string, v: any) => mockStorage.set(k, v),
            delete: async (k: string) => mockStorage.delete(k),
          });
        }),
        setAlarm: vi.fn().mockResolvedValue(undefined),
        deleteAlarm: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockImplementation(async (options?: any) => {
          const map = new Map();
          const prefix = options?.prefix;
          for (const [k, v] of mockStorage.entries()) {
            if (!prefix || k.startsWith(prefix)) {
              map.set(k, v);
            }
          }
          return map;
        }),
      },
      blockConcurrencyWhile: vi.fn(async (fn: any) => await fn()),
    };

    mockDb = {
      prepare: vi.fn().mockImplementation((query: string) => {
        if (query.includes('PRAGMA table_info')) {
          return {
            all: vi.fn().mockResolvedValue({
              results: [{ name: 'target_entry_price' }, { name: 'entry_status' }],
            }),
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_region: 'global',
              exchange_api_key: 'test-key',
              exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
              exchange_api_secret_encrypted: 'sec',
            }),
          }),
        };
      }),
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
  });

  it('Autonomous alert: succeeds when generation matches currentGen', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);

    const autoAlert: TradeAlert = {
      id: 'auto-alert-1',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 5,
      source: 'AUTONOMOUS',
    };
    mockStorage.set('alerts', [autoAlert]);

    const res = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'auto-alert-1' }),
      })
    );

    expect(res.status).toBe(200);
  });

  it('Autonomous alert: strictly rejected with HTTP 409 when generation is obsolete', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 6); // Generation rolled over to 6

    const staleAutoAlert: TradeAlert = {
      id: 'auto-alert-stale',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      generation: 5, // Old generation 5
      source: 'AUTONOMOUS',
    };
    mockStorage.set('alerts', [staleAutoAlert]);

    const res = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'auto-alert-stale' }),
      })
    );

    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.error).toContain('obsolete or invalid alarm generation');
  });

  it('Autonomous alert: strictly rejected with HTTP 409 when generation is missing', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('isActive', true);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('lock:alarmGeneration', 5);

    const legacyAlert: TradeAlert = {
      id: 'auto-alert-no-gen',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      // No generation and not marked MANUAL (defaults to autonomous)
    };
    mockStorage.set('alerts', [legacyAlert]);

    const res = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'auto-alert-no-gen' }),
      })
    );

    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.error).toContain('obsolete or invalid alarm generation');
  });

  it('Manual alert: executes successfully when registered via /register-alert with no generation', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('lock:alarmGeneration', 10); // Generation counter is at 10

    const manualAlert = {
      id: 'manual-alert-ta-screen',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      // NO generation!
    };

    // 1. Register alert via /register-alert (as exchange.ts does)
    const regRes = await bot.fetch(
      new Request('http://bot/register-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert: manualAlert }),
      })
    );
    expect(regRes.status).toBe(200);

    // 2. User confirms and presses EXECUTE TRADE -> /execute-trade
    const execRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'manual-alert-ta-screen' }),
      })
    );

    expect(execRes.status).toBe(200);
    const execBody = await execRes.json<any>();
    expect(execBody.success).toBe(true);
  });

  it('Manual alert: does NOT fail even if autonomous alarmGeneration rolls over', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('lock:alarmGeneration', 1);

    const manualAlert = {
      id: 'manual-alert-independent',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      source: 'MANUAL',
    };

    // Alert registered at generation 1
    mockStorage.set('alerts', [manualAlert]);

    // Background autonomous alarm activates / deactivates / switches strategy, advancing generation to 4
    mockStorage.set('lock:alarmGeneration', 4);

    // Manual trade executed now
    const execRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'manual-alert-independent' }),
      })
    );

    // Must NOT fail with "Alert belongs to an obsolete or invalid alarm generation"
    expect(execRes.status).toBe(200);
  });

  it('Manual alert: expired signals (>5 min) are still safely rejected with 400', async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');

    const expiredManualAlert = {
      id: 'manual-expired',
      symbol: 'BTC/USDT',
      signalPrice: 50000,
      targetEntryPrice: 50000,
      entryPrice: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 20,
      positionSize: 100,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date(Date.now() - 360000).toISOString(), // 6 minutes ago (>5 min TTL)
      status: 'pending',
      source: 'MANUAL',
    };
    mockStorage.set('alerts', [expiredManualAlert]);

    const execRes = await bot.fetch(
      new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId: 'manual-expired' }),
      })
    );

    expect(execRes.status).toBe(400);
    const body = await execRes.json<any>();
    expect(body.error).toContain('Signal has expired');
  });
});
