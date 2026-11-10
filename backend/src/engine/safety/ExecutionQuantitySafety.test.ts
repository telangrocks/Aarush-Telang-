import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot, TradeAlert } from "../../trading-bot";
import { ExchangeManager } from "../../exchanges";

// Mock security crypto
vi.mock("../../crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key")
}));

// Mock exchanges adapter
vi.mock("../../exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', last: 50100, bid: 50090, ask: 50110, high: 51000, low: 49000, volume: 100, quoteVolume: 5010000 }),
        fetchKlines: vi.fn().mockResolvedValue([]),
        fetchBalance: vi.fn().mockResolvedValue([]),
        fetchMarkets: vi.fn().mockResolvedValue([
          { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } }
        ]),
        fetchMarket: vi.fn().mockResolvedValue(
          { id: 'BTCUSDT', symbol: 'BTC/USDT', quote: 'USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 1.0 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } }
        ),
        fetchPositions: vi.fn().mockImplementation(async (cat, sym, zero) => (sym && zero ? [{ symbol: sym, positionIdx: 0, size: { toNumber: () => 0 } }] : [])),
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

describe("Phase 1 Execution Quantity Safety Invariant Regression Suite", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;
  let executeOrderSpy: any;

  beforeEach(async () => {
    mockStorage = new Map();
    mockState = {
      id: { toString: () => "mock-do-id" },
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
        delete: async (k: string) => mockStorage.delete(k),
        list: async ({ prefix }: { prefix?: string } = {}) => {
          const map = new Map();
          for (const [k, v] of mockStorage.entries()) {
            if (!prefix || k.startsWith(prefix)) map.set(k, v);
          }
          return map;
        },
        transaction: async (closure: (txn: any) => Promise<any>) => closure({
          get: async (k: string) => mockStorage.get(k),
          put: async (k: string, v: any) => mockStorage.set(k, v),
          delete: async (k: string) => mockStorage.delete(k),
          list: async ({ prefix }: { prefix?: string } = {}) => {
            const map = new Map();
            for (const [k, v] of mockStorage.entries()) {
              if (!prefix || k.startsWith(prefix)) map.set(k, v);
            }
            return map;
          }
        }),
      },
      blockConcurrencyWhile: async (fn: () => Promise<any>) => fn(),
      waitUntil: (p: Promise<any>) => p,
    };

    mockDb = {
      prepare: vi.fn().mockImplementation((query: string) => {
        if (query.includes('PRAGMA table_info')) {
          return {
            all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] })
          };
        }
        return {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_region: 'global',
              exchange_api_key: 'key',
              exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
              exchange_api_secret_encrypted: 'sec'
            })
          })
        };
      })
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      FCM_PROJECT_ID: "mock-fcm",
      FCM_CLIENT_EMAIL: "mock-sa@mock.iam.gserviceaccount.com",
      FCM_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n-----END PRIVATE KEY-----\n"
    };

    const exch = await import("../../exchanges");
    executeOrderSpy = vi.spyOn(exch.ExchangeManager, "executeIdempotentOrder");
    executeOrderSpy.mockClear();

    mockStorage.set('approvedCandidateRecord', {
      approvalGeneration: 1,
      budgetUsdt: 1000,
      approvedSymbols: ['BTCUSDT', 'BTC/USDT'],
      approvalState: 'FINAL_APPROVED',
      exchangeName: 'bybit',
      environment: 'demo',
      accountFingerprint: 'bybit:demo',
      orderType: 'ALL',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      symbolMetadataSnapshot: {}
    });
  });

  it("1. Rejects missing quantity with requireApprovedQuantity omitted -> HTTP 409 and 0 Bybit calls", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-1');
    mockStorage.set('alerts', [{
      id: 'alert-no-qty',
      symbol: 'BTC/USDT',
      signalPrice: 50100,
      targetEntryPrice: 50100,
      entryPrice: 50100,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 0,
      positionSize: 1000,
      // quantity is undefined
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      source: 'MANUAL'
    }]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-test-1', alertId: 'alert-no-qty' }) // requireApprovedQuantity is omitted
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const data = await res.json<any>();
    expect(data.code).toBe('MISSING_APPROVED_QUANTITY');
    expect(executeOrderSpy).not.toHaveBeenCalled();
  });

  it("2. Rejects missing quantity with requireApprovedQuantity: false -> HTTP 409 and 0 Bybit calls", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-2');
    mockStorage.set('alerts', [{
      id: 'alert-no-qty-flag-false',
      symbol: 'BTC/USDT',
      signalPrice: 50100,
      targetEntryPrice: 50100,
      entryPrice: 50100,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 0,
      positionSize: 1000,
      quantity: undefined,
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      source: 'MANUAL'
    }]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-test-2', alertId: 'alert-no-qty-flag-false', requireApprovedQuantity: false })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const data = await res.json<any>();
    expect(data.code).toBe('MISSING_APPROVED_QUANTITY');
    expect(executeOrderSpy).not.toHaveBeenCalled();
  });

  it("3. Rejects null, zero, negative, NaN and infinite stored quantities -> HTTP 409 and 0 Bybit calls", async () => {
    const invalidQuantities = [null, 0, -0.5, NaN, Infinity, -Infinity];

    for (let i = 0; i < invalidQuantities.length; i++) {
      const invalidQty = invalidQuantities[i];
      const alertId = `alert-invalid-qty-${i}`;
      const bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('userId', 'user-test-3');
      mockStorage.set('alerts', [{
        id: alertId,
        symbol: 'BTC/USDT',
        signalPrice: 50100,
        targetEntryPrice: 50100,
        entryPrice: 50100,
        stopLoss: 49000,
        takeProfit: 52000,
        estimatedPnl: 0,
        positionSize: 1000,
        quantity: invalidQty as any,
        strategy: 'ScalperV2',
        side: 'BUY',
        timestamp: new Date().toISOString(),
        status: 'pending',
        source: 'MANUAL'
      }]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-test-3', alertId })
      });

      const res = await bot.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json<any>();
      expect(data.code).toBe('MISSING_APPROVED_QUANTITY');
      expect(executeOrderSpy).not.toHaveBeenCalled();
    }
  });

  it("4. Rejects tampered client quantity that differs from stored approved quantity -> HTTP 409 and 0 Bybit calls", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-4');
    mockStorage.set('alerts', [{
      id: 'alert-tamper-qty',
      symbol: 'BTC/USDT',
      signalPrice: 50100,
      targetEntryPrice: 50100,
      entryPrice: 50100,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 0,
      positionSize: 1000,
      quantity: 0.02, // Approved quantity
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      source: 'MANUAL'
    }]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-test-4', alertId: 'alert-tamper-qty', quantity: 0.05 }) // Tampered client quantity
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const data = await res.json<any>();
    expect(data.code).toBe('QUANTITY_TAMPERED');
    expect(executeOrderSpy).not.toHaveBeenCalled();
  });

  it("5. Rejects missing quantity even when a large requestedBudget ($10,000) is provided -> No budget synthesis", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-5');
    mockStorage.set('alerts', [{
      id: 'alert-large-budget-no-qty',
      symbol: 'BTC/USDT',
      signalPrice: 50100,
      targetEntryPrice: 50100,
      entryPrice: 50100,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 0,
      positionSize: 10000,
      requestedBudget: 10000,
      quantity: undefined, // Missing approved quantity
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      source: 'MANUAL'
    }]);

    mockStorage.set('approvedCandidateRecord', {
      ...mockStorage.get('approvedCandidateRecord'),
      budgetUsdt: 10000
    });

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-test-5', alertId: 'alert-large-budget-no-qty', positionSizeUsdt: 10000 })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);
    const data = await res.json<any>();
    expect(data.code).toBe('MISSING_APPROVED_QUANTITY');
    expect(executeOrderSpy).not.toHaveBeenCalled();
  });

  it("6. Legitimate execution succeeds when alert carries authoritative approved quantity matching client quantity", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'user-test-6');
    mockStorage.set('alerts', [{
      id: 'alert-legit-approved-qty',
      symbol: 'BTC/USDT',
      signalPrice: 50100,
      targetEntryPrice: 50100,
      entryPrice: 50100,
      stopLoss: 49000,
      takeProfit: 52000,
      estimatedPnl: 0,
      positionSize: 1000,
      quantity: 0.01, // Approved quantity (0.01 * 50100 = $501 <= $1000 exposure)
      strategy: 'ScalperV2',
      side: 'BUY',
      timestamp: new Date().toISOString(),
      status: 'pending',
      source: 'MANUAL'
    }]);

    const req = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user-test-6',
        alertId: 'alert-legit-approved-qty',
        quantity: 0.01,
        requireApprovedQuantity: true
      })
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);
    const data = await res.json<any>();
    expect(data.success).toBe(true);
    expect(executeOrderSpy).toHaveBeenCalledTimes(1);
  });
});
