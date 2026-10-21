import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradingBot } from '../../src/trading-bot';
import BigNumber from 'bignumber.js';

// Mock security crypto
vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mocked_secret_key'),
}));

// Mock exchanges adapter
vi.mock('../../src/exchanges', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', last: 50100 }),
        fetchKlines: vi.fn().mockResolvedValue([]),
        fetchBalance: vi.fn().mockResolvedValue([]),
        fetchMarkets: vi.fn().mockResolvedValue([
          { id: 'BTCUSDT', symbol: 'BTC/USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 } } },
          { id: 'ZECUSDT', symbol: 'ZEC/USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 } } },
        ]),
        fetchMarket: vi.fn().mockImplementation(async (sym: string) => {
          if (sym.includes('ZEC')) {
            return { id: 'ZECUSDT', symbol: 'ZEC/USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.01 }, limits: { cost: { min: 5 } } };
          }
          return { id: 'BTCUSDT', symbol: 'BTC/USDT', active: true, category: 'linear', precision: { amount: 0.01, price: 0.1 }, limits: { cost: { min: 5 } } };
        }),
        createOrder: vi.fn().mockResolvedValue({
          id: 'ord-restoration-1',
          status: 'closed',
          filled: { toNumber: () => 0.02 },
          amount: { toNumber: () => 0.02 },
          average: { toNumber: () => 50100 },
          stopLoss: 49000,
          takeProfit: 52000,
        }),
        supportsOco: vi.fn().mockReturnValue(false),
        createOcoOrder: vi.fn(),
      }),
      executeIdempotentOrder: vi.fn().mockResolvedValue({
        id: 'ord-restoration-1',
        status: 'closed',
        filled: { toNumber: () => 0.02 },
        amount: { toNumber: () => 0.02 },
        average: { toNumber: () => 50100 },
        stopLoss: 49000,
        takeProfit: 52000,
      }),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('testnet'),
    normalizeRegion: vi.fn().mockReturnValue('global'),
  };
});

describe('CryptoPulse Restoration Regression Tests — Fence B & Order Precision', () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;

  beforeEach(() => {
    mockStorage = new Map();
    mockState = {
      id: { toString: () => 'mock-do-id' },
      storage: {
        get: async (keyOrKeys: string | string[]) => {
          if (Array.isArray(keyOrKeys)) {
            const res = new Map();
            for (const k of keyOrKeys) {
              if (mockStorage.has(k)) res.set(k, mockStorage.get(k));
            }
            return res;
          }
          return mockStorage.get(keyOrKeys);
        },
        put: async (keyOrEntries: string | Record<string, any>, val?: any) => {
          if (typeof keyOrEntries === 'string') {
            mockStorage.set(keyOrEntries, val);
          } else if (keyOrEntries && typeof keyOrEntries === 'object') {
            for (const [k, v] of Object.entries(keyOrEntries)) {
              mockStorage.set(k, v);
            }
          }
        },
        delete: async (key: string) => mockStorage.delete(key),
        list: async (opts?: { prefix?: string }) => {
          const res = new Map();
          for (const [k, v] of mockStorage.entries()) {
            if (!opts?.prefix || k.startsWith(opts.prefix)) {
              res.set(k, v);
            }
          }
          return res;
        },
        transaction: async (cb: any) => cb({
          get: async (keyOrKeys: string | string[]) => {
            if (Array.isArray(keyOrKeys)) {
              const res = new Map();
              for (const k of keyOrKeys) {
                if (mockStorage.has(k)) res.set(k, mockStorage.get(k));
              }
              return res;
            }
            return mockStorage.get(keyOrKeys);
          },
          put: async (keyOrEntries: string | Record<string, any>, val?: any) => {
            if (typeof keyOrEntries === 'string') {
              mockStorage.set(keyOrEntries, val);
            } else if (keyOrEntries && typeof keyOrEntries === 'object') {
              for (const [k, v] of Object.entries(keyOrEntries)) {
                mockStorage.set(k, v);
              }
            }
          },
          delete: async (k: string) => mockStorage.delete(k),
          list: async (opts?: { prefix?: string }) => {
            const res = new Map();
            for (const [k, v] of mockStorage.entries()) {
              if (!opts?.prefix || k.startsWith(opts.prefix)) {
                res.set(k, v);
              }
            }
            return res;
          },
        }),
        blockConcurrencyWhile: async (cb: any) => cb(),
        setAlarm: vi.fn(),
      },
      blockConcurrencyWhile: async (cb: any) => cb(),
    };

    mockDb = {
      prepare: vi.fn().mockImplementation((query: string) => {
        if (query.includes('PRAGMA table_info')) {
          return {
            all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] }),
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_region: 'global',
              exchange_api_key: 'test_key',
              exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
              exchange_api_secret_encrypted: 'test_sec',
            }),
          }),
        };
      }),
      run: vi.fn().mockResolvedValue({ success: true }),
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: 'test_encryption_key_32_bytes_long!!',
      GLOBAL_TRADING_HALT: 'false',
    };
  });

  // ── Fence B Restoration Tests ───────────────────────────────────────────────

  it('RC-2: Fence B accepts valid unexpired autonomous alert when alarm generation advances during user review', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // Setup active bot state
    mockStorage.set('userId', 'user-restored-1');
    mockStorage.set('isActive', true);
    mockStorage.set('coinId', 'BTC/USDT');
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('positionSize', 1000);

    // Bot alarm generation is currently 2
    mockStorage.set('lock:alarmGeneration', 2);

    // Alert was generated during current session (gen 2), 45 seconds ago (well within 5-minute TTL)
    const alertId = 'alert-gen-test-1';
    mockStorage.set('alerts', [
      {
        id: alertId,
        symbol: 'BTC/USDT',
        signalPrice: 50100,
        targetEntryPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 19,
        positionSize: 1000,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date(Date.now() - 45_000).toISOString(),
        status: 'pending',
        generation: 2,
        source: 'AUTONOMOUS',
      },
    ]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-restored-1', coinId: 'BTC/USDT', alertId }),
    });

    const res = await bot.fetch(req);
    const body = await res.json<any>();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('RC-2: Fence B rejects autonomous alert when generation belongs to an obsolete activation session', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set('userId', 'user-restored-1');
    mockStorage.set('isActive', true);
    mockStorage.set('lock:alarmGeneration', 2); // Session is now 2

    const alertId = 'alert-obsolete-gen';
    mockStorage.set('alerts', [
      {
        id: alertId,
        symbol: 'BTC/USDT',
        signalPrice: 50100,
        targetEntryPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 19,
        positionSize: 1000,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1, // Obsolete session 1
        source: 'AUTONOMOUS',
      },
    ]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-restored-1', alertId }),
    });

    const res = await bot.fetch(req);
    const body = await res.json<any>();

    expect(res.status).toBe(409);
    expect(body.code).toBe('STALE_AUTONOMOUS_GENERATION');
  });

  it('RC-2: Fence B rejects autonomous alert when signal age exceeds 5-minute TTL', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set('userId', 'user-restored-1');
    mockStorage.set('isActive', true);
    mockStorage.set('lock:alarmGeneration', 1);

    const alertId = 'alert-stale-ttl';
    mockStorage.set('alerts', [
      {
        id: alertId,
        symbol: 'BTCUSDT',
        signalPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 19,
        positionSize: 500,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date(Date.now() - 310_000).toISOString(), // 5m 10s old (> 300,000ms)
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      },
    ]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-restored-1', alertId }),
    });

    const res = await bot.fetch(req);
    const body = await res.json<any>();

    expect(res.status).toBe(400);
    expect(body.error).toContain('Signal has expired');
  });

  it('RC-2: Fence B rejects autonomous alert when bot is inactive', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set('userId', 'user-restored-1');
    mockStorage.set('isActive', false); // Bot deactivated
    mockStorage.set('lock:alarmGeneration', 2);

    const alertId = 'alert-inactive-bot';
    mockStorage.set('alerts', [
      {
        id: alertId,
        symbol: 'BTCUSDT',
        signalPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 19,
        positionSize: 500,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 1,
        source: 'AUTONOMOUS',
      },
    ]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-restored-1', alertId }),
    });

    const res = await bot.fetch(req);
    const body = await res.json<any>();

    expect(res.status).toBe(409);
    expect(body.code).toBe('BOT_INACTIVE_AUTONOMOUS_REJECTED');
  });

  it('RC-2: Fence B rejects alert with future generation exceeding current generation', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    mockStorage.set('userId', 'user-restored-1');
    mockStorage.set('isActive', true);
    mockStorage.set('lock:alarmGeneration', 1);

    const alertId = 'alert-future-gen';
    mockStorage.set('alerts', [
      {
        id: alertId,
        symbol: 'BTCUSDT',
        signalPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 19,
        positionSize: 500,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        generation: 99, // Impossible future generation
        source: 'AUTONOMOUS',
      },
    ]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-restored-1', alertId }),
    });

    const res = await bot.fetch(req);
    const body = await res.json<any>();

    expect(res.status).toBe(409);
    expect(body.code).toBe('STALE_AUTONOMOUS_GENERATION');
  });

  // ── SL/TP Tick Quantization & Protection Tests ──────────────────────────────

  it('RC-4: Quantization on ZEC/USDT (tick 0.01) matches Bybit specifications without triggering exposure lock', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // BUY order test:
    // Entry: 33.455 -> SL calculated: 32.778, TP calculated: 34.562
    // BybitAdapter quantizes: BUY SL with ROUND_FLOOR = 32.77, BUY TP with ROUND_CEIL = 34.57
    const tickSize = 0.01;
    const expectedBuySL = 32.778;
    const expectedBuyTP = 34.562;

    const bybitSL = new BigNumber(expectedBuySL).dividedBy(tickSize).integerValue(BigNumber.ROUND_FLOOR).multipliedBy(tickSize).toNumber();
    const bybitTP = new BigNumber(expectedBuyTP).dividedBy(tickSize).integerValue(BigNumber.ROUND_CEIL).multipliedBy(tickSize).toNumber();

    expect(bybitSL).toBe(32.77);
    expect(bybitTP).toBe(34.57);

    // Verify verifyAndEnforceProtection evaluates this as valid:
    const mockProvider = {
      enforceProtectionCheck: true,
      fetchPositions: vi.fn().mockResolvedValue([]),
    };

    const verifyResult = await (bot as any).verifyAndEnforceProtection({
      provider: mockProvider,
      rawOrder: { id: 'ord-zec-1', stopLoss: bybitSL, takeProfit: bybitTP },
      positionId: 'pos-zec-1',
      alertId: 'alert-zec-1',
      userId: 'user-restored-1',
      exchangeName: 'bybit',
      environment: 'demo',
      symbol: 'ZEC/USDT',
      category: 'linear',
      side: 'BUY',
      filledQuantity: 1.5,
      expectedSL: expectedBuySL,
      expectedTP: expectedBuyTP,
      tickSize: 0.01,
    });

    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.emergencyClosed).toBe(false);
  });

  it('RC-4: Quantization on SELL order correctly inverts rounding modes', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    // SELL order:
    // Entry: 33.45 -> SL is above entry (34.562), TP is below entry (32.778)
    // BybitAdapter quantizes: SELL SL with ROUND_CEIL = 34.57, SELL TP with ROUND_FLOOR = 32.77
    const tickSize = 0.01;
    const expectedSellSL = 34.562;
    const expectedSellTP = 32.778;

    const bybitSL = new BigNumber(expectedSellSL).dividedBy(tickSize).integerValue(BigNumber.ROUND_CEIL).multipliedBy(tickSize).toNumber();
    const bybitTP = new BigNumber(expectedSellTP).dividedBy(tickSize).integerValue(BigNumber.ROUND_FLOOR).multipliedBy(tickSize).toNumber();

    expect(bybitSL).toBe(34.57);
    expect(bybitTP).toBe(32.77);

    const mockProvider = {
      enforceProtectionCheck: true,
      fetchPositions: vi.fn().mockResolvedValue([]),
    };

    const verifyResult = await (bot as any).verifyAndEnforceProtection({
      provider: mockProvider,
      rawOrder: { id: 'ord-sell-1', stopLoss: bybitSL, takeProfit: bybitTP },
      positionId: 'pos-sell-1',
      alertId: 'alert-sell-1',
      userId: 'user-restored-1',
      exchangeName: 'bybit',
      environment: 'demo',
      symbol: 'ZEC/USDT',
      category: 'linear',
      side: 'SELL',
      filledQuantity: 1.5,
      expectedSL: expectedSellSL,
      expectedTP: expectedSellTP,
      tickSize: 0.01,
    });

    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.emergencyClosed).toBe(false);
  });

  it('RC-4: Sub-cent tick size (0.000001) preserves micro-precision without rounding distortion', async () => {
    const bot = new TradingBot(mockState, mockEnv);

    const tickSize = 0.000001;
    const expectedSL = 0.0045231;
    const expectedTP = 0.0051289;

    const bybitSL = new BigNumber(expectedSL).dividedBy(tickSize).integerValue(BigNumber.ROUND_FLOOR).multipliedBy(tickSize).toNumber();
    const bybitTP = new BigNumber(expectedTP).dividedBy(tickSize).integerValue(BigNumber.ROUND_CEIL).multipliedBy(tickSize).toNumber();

    expect(bybitSL).toBe(0.004523);
    expect(bybitTP).toBe(0.005129);

    const mockProvider = {
      enforceProtectionCheck: true,
      fetchPositions: vi.fn().mockResolvedValue([]),
    };

    const verifyResult = await (bot as any).verifyAndEnforceProtection({
      provider: mockProvider,
      rawOrder: { id: 'ord-micro-1', stopLoss: bybitSL, takeProfit: bybitTP },
      positionId: 'pos-micro-1',
      alertId: 'alert-micro-1',
      userId: 'user-restored-1',
      exchangeName: 'bybit',
      environment: 'demo',
      symbol: 'SOPH/USDT',
      category: 'linear',
      side: 'BUY',
      filledQuantity: 1000,
      expectedSL: expectedSL,
      expectedTP: expectedTP,
      tickSize: tickSize,
    });

    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.emergencyClosed).toBe(false);
  });
});
