import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot, TradeAlert } from "../../trading-bot";
import { ExchangeManager } from "../../exchanges";
import { sendTradeNotification } from "../../handlers/notifications";

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

describe("Stage 2.1 Server-Side Execution Authorization and FCM Compatibility Suite", () => {
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
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_api_key_encrypted: 'mock_enc_key',
            exchange_api_key_iv: 'mock_iv',
            exchange_api_key_salt: 'mock_salt',
            exchange_api_secret_encrypted: 'mock_enc_secret',
            exchange_api_secret_iv: 'mock_iv',
            exchange_api_secret_salt: 'mock_salt',
            fcm_token: 'secret-fcm-token-12345'
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [] })
        };
      })
    };

    mockEnv = {
      DB: mockDb,
      ENVIRONMENT: 'test',
      FCM_SERVER_KEY: 'test-server-key'
    };

    const provider: any = await (ExchangeManager.getProvider as any)();
    executeOrderSpy = provider.createOrder;
    executeOrderSpy.mockClear();
    (ExchangeManager.executeIdempotentOrder as any).mockClear();
  });

  const setupBotForExecution = async (alert: TradeAlert) => {
    mockStorage.set('userId', 'user-stage21-123');
    mockStorage.set('isActive', true);
    mockStorage.set('lock:alarmGeneration', 1);
    mockStorage.set('strategy', 'ScalperV2');
    mockStorage.set('coinId', 'BTC/USDT');
    mockStorage.set('alerts', [alert]);
    mockStorage.set('approvedCandidateRecord', {
      approvalGeneration: 1,
      userId: 'user-stage21-123',
      budgetUsdt: 1000,
      approvedSymbols: ['BTCUSDT', 'BTC/USDT'],
      approvalState: 'FINAL_APPROVED',
      exchangeName: 'bybit',
      environment: 'testnet',
      accountFingerprint: 'bybit:testnet',
      orderType: 'ALL',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      symbolMetadataSnapshot: {}
    });

    const bot = new TradingBot(mockState, mockEnv);
    const req = new Request('http://bot/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-stage21-123' })
    });
    await bot.fetch(req);
    return bot;
  };

  // --- REQUIREMENT 1: Explicit false with positive stored quantity -> ALERT_NOT_EXECUTABLE, 0 Bybit calls ---
  it("TEST 1: Explicit false with positive stored quantity -> HTTP 409 ALERT_NOT_EXECUTABLE, zero Bybit calls", async () => {
    const malformedAlert: TradeAlert = {
      id: "alert-false-with-qty",
      symbol: "BTC/USDT",
      side: "BUY",
      entryPrice: 50000,
      signalPrice: 50000,
      stopLoss: 49500,
      takeProfit: 51000,
      estimatedPnl: 20,
      positionSize: 1000,
      quantity: 0.02, // Corrupted/malformed: positive quantity on non-executable alert
      isExecutable: false,
      ineligibilityReason: "BELOW_MIN_NOTIONAL",
      strategy: "ScalperV2_NEW",
      timestamp: new Date().toISOString(),
      status: "pending",
      generation: 1,
      source: "AUTONOMOUS",
      dispatchState: "SENT"
    };

    const bot = await setupBotForExecution(malformedAlert);

    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertId: "alert-false-with-qty",
        symbol: "BTC/USDT",
        side: "BUY",
        quantity: 0.02,
        requireApprovedQuantity: true
      })
    });

    const res = await bot.fetch(execReq);
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.code).toBe("ALERT_NOT_EXECUTABLE");
    expect(body.error).toContain("marked non-executable");
    expect(executeOrderSpy).not.toHaveBeenCalled();
    expect(ExchangeManager.executeIdempotentOrder).not.toHaveBeenCalled();
  });

  // --- REQUIREMENT 2: Explicit false without quantity -> ALERT_NOT_EXECUTABLE, 0 Bybit calls ---
  it("TEST 2: Explicit false without quantity -> HTTP 409 ALERT_NOT_EXECUTABLE, zero Bybit calls", async () => {
    const signalOnlyAlert: TradeAlert = {
      id: "alert-false-no-qty",
      symbol: "BTC/USDT",
      side: "BUY",
      entryPrice: 50000,
      signalPrice: 50000,
      stopLoss: 49500,
      takeProfit: 51000,
      estimatedPnl: 0,
      positionSize: 0,
      quantity: undefined,
      isExecutable: false,
      ineligibilityReason: "INSUFFICIENT_BUDGET",
      strategy: "ScalperV2_NEW",
      timestamp: new Date().toISOString(),
      status: "pending",
      generation: 1,
      source: "AUTONOMOUS",
      dispatchState: "SENT"
    };

    const bot = await setupBotForExecution(signalOnlyAlert);

    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertId: "alert-false-no-qty",
        symbol: "BTC/USDT",
        side: "BUY"
      })
    });

    const res = await bot.fetch(execReq);
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.code).toBe("ALERT_NOT_EXECUTABLE");
    expect(executeOrderSpy).not.toHaveBeenCalled();
    expect(ExchangeManager.executeIdempotentOrder).not.toHaveBeenCalled();
  });

  // --- REQUIREMENT 3: Explicit true without valid quantity -> MISSING_APPROVED_QUANTITY ---
  it("TEST 3: Explicit true without valid quantity -> HTTP 409 MISSING_APPROVED_QUANTITY", async () => {
    const malformedTrueAlert: TradeAlert = {
      id: "alert-true-no-qty",
      symbol: "BTC/USDT",
      side: "BUY",
      entryPrice: 50000,
      signalPrice: 50000,
      stopLoss: 49500,
      takeProfit: 51000,
      estimatedPnl: 0,
      positionSize: 0,
      quantity: undefined, // Malformed: true but missing quantity
      isExecutable: true,
      strategy: "ScalperV2_NEW",
      timestamp: new Date().toISOString(),
      status: "pending",
      generation: 1,
      source: "AUTONOMOUS",
      dispatchState: "SENT"
    };

    const bot = await setupBotForExecution(malformedTrueAlert);

    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertId: "alert-true-no-qty",
        symbol: "BTC/USDT",
        side: "BUY"
      })
    });

    const res = await bot.fetch(execReq);
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.code).toBe("MISSING_APPROVED_QUANTITY");
    expect(executeOrderSpy).not.toHaveBeenCalled();
    expect(ExchangeManager.executeIdempotentOrder).not.toHaveBeenCalled();
  });

  // --- REQUIREMENT 4: Legacy undefined with valid stored quantity -> existing Phase 1 behavior preserved ---
  it("TEST 4: Legacy undefined with valid stored quantity -> existing Phase 1 behavior preserved", async () => {
    const legacyValidAlert: TradeAlert = {
      id: "alert-legacy-valid-qty",
      symbol: "BTC/USDT",
      side: "BUY",
      entryPrice: 50000,
      signalPrice: 50000,
      stopLoss: 49500,
      takeProfit: 51000,
      estimatedPnl: 20,
      positionSize: 1000,
      quantity: 0.02,
      isExecutable: undefined, // Legacy alert: field is absent/undefined
      strategy: "ScalperV2_NEW",
      timestamp: new Date().toISOString(),
      status: "pending",
      generation: 1,
      source: "AUTONOMOUS",
      dispatchState: "SENT"
    };

    const bot = await setupBotForExecution(legacyValidAlert);

    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertId: "alert-legacy-valid-qty",
        symbol: "BTC/USDT",
        side: "BUY",
        quantity: 0.02,
        requireApprovedQuantity: true
      })
    });

    const res = await bot.fetch(execReq);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    // Order was executed via Bybit adapter
    expect(ExchangeManager.executeIdempotentOrder).toHaveBeenCalled();
  });

  // --- REQUIREMENT 5: Legacy undefined with missing/invalid quantity -> rejected ---
  it("TEST 5: Legacy undefined with missing/invalid quantity -> HTTP 409 MISSING_APPROVED_QUANTITY", async () => {
    const legacyInvalidAlert: TradeAlert = {
      id: "alert-legacy-missing-qty",
      symbol: "BTC/USDT",
      side: "BUY",
      entryPrice: 50000,
      signalPrice: 50000,
      stopLoss: 49500,
      takeProfit: 51000,
      estimatedPnl: 0,
      positionSize: 0,
      quantity: undefined, // Legacy alert with missing quantity
      isExecutable: undefined,
      strategy: "ScalperV2_NEW",
      timestamp: new Date().toISOString(),
      status: "pending",
      generation: 1,
      source: "AUTONOMOUS",
      dispatchState: "SENT"
    };

    const bot = await setupBotForExecution(legacyInvalidAlert);

    const execReq = new Request('http://bot/execute-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertId: "alert-legacy-missing-qty",
        symbol: "BTC/USDT",
        side: "BUY"
      })
    });

    const res = await bot.fetch(execReq);
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.code).toBe("MISSING_APPROVED_QUANTITY");
    expect(executeOrderSpy).not.toHaveBeenCalled();
    expect(ExchangeManager.executeIdempotentOrder).not.toHaveBeenCalled();
  });

  // --- REQUIREMENT 6: Explicit false FCM payload -> false, no quantity ---
  it("TEST 6: Explicit false FCM payload -> isExecutable: 'false', quantity omitted", async () => {
    let capturedPayload: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      if (url.includes('fcm.googleapis.com')) {
        capturedPayload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ name: 'projects/test/messages/12345' }), { status: 200 });
      }
      return originalFetch(url, opts);
    });

    try {
      const res = await sendTradeNotification(mockEnv, "user-fcm-1", "alert-fcm-false", {
        symbol: "BTC/USDT",
        side: "BUY",
        entryPrice: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        estimatedPnl: 0,
        strategy: "ScalperV2_NEW",
        quantity: 0.05, // Malformed: carries quantity but isExecutable is false
        isExecutable: false,
        ineligibilityReason: "BELOW_MIN_NOTIONAL"
      });

      expect(res.success).toBe(true);
      expect(capturedPayload).not.toBeNull();
      const data = capturedPayload.data || capturedPayload.message?.data;
      expect(data.isExecutable).toBe("false");
      expect(data.quantity).toBeUndefined();
      expect(data.ineligibilityReason).toBe("BELOW_MIN_NOTIONAL");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --- REQUIREMENT 7: Explicit true with valid stored quantity -> true, approved quantity included ---
  it("TEST 7: Explicit true with valid stored quantity -> isExecutable: 'true', quantity included", async () => {
    let capturedPayload: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      if (url.includes('fcm.googleapis.com')) {
        capturedPayload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ name: 'projects/test/messages/12345' }), { status: 200 });
      }
      return originalFetch(url, opts);
    });

    try {
      const res = await sendTradeNotification(mockEnv, "user-fcm-2", "alert-fcm-true", {
        symbol: "BTC/USDT",
        side: "BUY",
        entryPrice: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        estimatedPnl: 20,
        strategy: "ScalperV2_NEW",
        quantity: 0.05,
        isExecutable: true
      });

      expect(res.success).toBe(true);
      expect(capturedPayload).not.toBeNull();
      const data = capturedPayload.data || capturedPayload.message?.data;
      expect(data.isExecutable).toBe("true");
      expect(data.quantity).toBe("0.05");
      expect(data.ineligibilityReason).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --- REQUIREMENT 8: Legacy valid quantity -> FCM executable compatibility preserved ---
  it("TEST 8: Legacy valid quantity -> isExecutable: 'true', approved quantity included", async () => {
    let capturedPayload: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      if (url.includes('fcm.googleapis.com')) {
        capturedPayload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ name: 'projects/test/messages/12345' }), { status: 200 });
      }
      return originalFetch(url, opts);
    });

    try {
      const res = await sendTradeNotification(mockEnv, "user-fcm-3", "alert-fcm-legacy-valid", {
        symbol: "BTC/USDT",
        side: "BUY",
        entryPrice: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        estimatedPnl: 20,
        strategy: "ScalperV2_NEW",
        quantity: 0.02,
        isExecutable: undefined // Legacy alert: isExecutable is undefined
      });

      expect(res.success).toBe(true);
      expect(capturedPayload).not.toBeNull();
      const data = capturedPayload.data || capturedPayload.message?.data;
      expect(data.isExecutable).toBe("true");
      expect(data.quantity).toBe("0.02");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // --- REQUIREMENT 9: Legacy missing/invalid quantity -> false, no quantity ---
  it("TEST 9: Legacy missing/invalid quantity -> isExecutable: 'false', quantity omitted", async () => {
    let capturedPayload: any = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      if (url.includes('fcm.googleapis.com')) {
        capturedPayload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ name: 'projects/test/messages/12345' }), { status: 200 });
      }
      return originalFetch(url, opts);
    });

    try {
      const res = await sendTradeNotification(mockEnv, "user-fcm-4", "alert-fcm-legacy-invalid", {
        symbol: "BTC/USDT",
        side: "BUY",
        entryPrice: 50000,
        stopLoss: 49500,
        takeProfit: 51000,
        estimatedPnl: 0,
        strategy: "ScalperV2_NEW",
        quantity: undefined, // Legacy alert without quantity
        isExecutable: undefined
      });

      expect(res.success).toBe(true);
      expect(capturedPayload).not.toBeNull();
      const data = capturedPayload.data || capturedPayload.message?.data;
      expect(data.isExecutable).toBe("false");
      expect(data.quantity).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
