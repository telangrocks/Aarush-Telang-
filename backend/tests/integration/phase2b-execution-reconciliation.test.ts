import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";
import BigNumber from "bignumber.js";

// Mock security crypto
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key")
}));

// Mock exchanges adapter
const mockFetchOrder = vi.fn();
const mockFetchClosedOrders = vi.fn();
const mockFetchMyTrades = vi.fn();

vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchOrder: (...args: any[]) => mockFetchOrder(...args),
        fetchClosedOrders: (...args: any[]) => mockFetchClosedOrders(...args),
        fetchMyTrades: (...args: any[]) => mockFetchMyTrades(...args),
        fetchPositions: vi.fn().mockResolvedValue([]),
        fetchTicker: vi.fn().mockResolvedValue({
          symbol: 'ZRO/USDT',
          last: { toNumber: () => 1.1674 }
        }),
      }),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('demo'),
    resolveCanonicalRoutingRegion: vi.fn().mockReturnValue('global'),
  };
});

describe("Phase 2B — Authoritative Execution & Fill Reconciliation Tests", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let d1Positions: Map<string, any>;

  beforeEach(() => {
    mockStorage = new Map();
    d1Positions = new Map();
    mockFetchOrder.mockReset();
    mockFetchClosedOrders.mockReset();
    mockFetchMyTrades.mockReset();

    mockState = {
      id: { toString: () => "mock-do-id" },
      storage: {
        get: async (key: string) => mockStorage.get(key),
        put: async (key: string, val: any) => mockStorage.set(key, val),
        delete: async (key: string) => mockStorage.delete(key),
        setAlarm: vi.fn(),
        list: async () => mockStorage
      },
      blockConcurrencyWhile: async (cb: any) => cb()
    };

    mockEnv = {
      DB: {
        prepare: vi.fn().mockImplementation((query: string) => ({
          bind: vi.fn().mockImplementation((...args: any[]) => ({
            run: vi.fn().mockImplementation(async () => {
              if (query.includes('UPDATE trade_positions')) {
                const id = args[4] || args[1];
                const pos = d1Positions.get(id);
                if (pos) {
                  if (query.includes('SET entry_status = ?')) {
                    pos.entry_status = args[0];
                    pos.average_fill_price = args[1];
                    pos.filled_quantity = args[2];
                    pos.status = 'OPEN';
                  } else if (query.includes('SET entry_status = \'FAILED\'')) {
                    pos.entry_status = 'FAILED';
                    pos.status = 'CANCELLED';
                  }
                  d1Positions.set(id, pos);
                }
              }
              return { success: true };
            }),
            first: vi.fn().mockImplementation(async () => {
              if (query.includes('FROM users')) {
                return {
                  exchange_name: 'bybit',
                  exchange_environment: 'demo',
                  exchange_region: 'global',
                  exchange_api_key: 'key_123',
                  exchange_api_secret_encrypted: 'sec_enc',
                  exchange_api_secret_iv: 'iv',
                  exchange_api_secret_salt: 'salt'
                };
              }
              if (query.includes('FROM trade_positions')) {
                const id = args[0];
                return d1Positions.get(id) || null;
              }
              return null;
            }),
            all: vi.fn().mockResolvedValue({ results: [] })
          }))
        }))
      },
      COOKIE_ENCRYPTION_KEY: 'test_encryption_key',
      GLOBAL_TRADING_HALT: "false"
    };
  });

  it("reconciles PENDING_ENTRY order to FILLED when Bybit confirms execution fill", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertId = "c3cbe99c-2750-49f0-91a8-0777be8c3fe2";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    mockStorage.set(`intent:order:${alertId}`, {
      intentId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      orderType: "market",
      qty: "85.6604",
      status: "DISPATCHED",
      createdAt: Date.now(),
      reconciliationAttemptCount: 0
    });

    d1Positions.set(alertId, {
      id: alertId,
      user_id: userId,
      symbol: "ZRO/USDT",
      side: "BUY",
      entry_price: 1.1674,
      target_entry_price: 1.1674,
      average_fill_price: null,
      quantity: 85.6604,
      filled_quantity: 0,
      status: "OPEN",
      entry_status: "PENDING_ENTRY",
      exchange: "bybit",
      environment: "demo"
    });

    // Mock Bybit returning FILLED order
    mockFetchOrder.mockResolvedValue({
      id: "bybit_ord_12345",
      clientOrderId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      type: "market",
      status: "closed", // Bybit Filled
      price: new BigNumber(0),
      average: new BigNumber(1.1674),
      amount: new BigNumber(85.6604),
      filled: new BigNumber(85.6604),
      remaining: new BigNumber(0)
    });

    const req = new Request(`http://bot/execution-status?positionId=${alertId}`, { method: "GET" });
    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const data = await res.json<any>();
    expect(data.success).toBe(true);
    expect(data.isFilled).toBe(true);
    expect(data.isTerminal).toBe(true);
    expect(data.entryStatus).toBe("FILLED");
    expect(data.actualFillPrice).toBe(1.1674);
    expect(data.filledQuantity).toBe(85.6604);

    // Verify D1 was updated
    const updatedPos = d1Positions.get(alertId);
    expect(updatedPos.entry_status).toBe("FILLED");
    expect(updatedPos.average_fill_price).toBe(1.1674);
    expect(updatedPos.filled_quantity).toBe(85.6604);

    // Verify WAL intent was updated
    const updatedIntent = mockStorage.get(`intent:order:${alertId}`);
    expect(updatedIntent.status).toBe("FILLED");
    expect(updatedIntent.actualFillPrice).toBe("1.1674");
  });

  it("reconciles PENDING_ENTRY order to PARTIALLY_FILLED when Bybit reports partial execution", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertId = "c3cbe99c-2750-49f0-91a8-0777be8c3fe2";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    mockStorage.set(`intent:order:${alertId}`, {
      intentId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      qty: "100.0",
      status: "DISPATCHED",
      createdAt: Date.now(),
      reconciliationAttemptCount: 0
    });

    d1Positions.set(alertId, {
      id: alertId,
      user_id: userId,
      symbol: "ZRO/USDT",
      side: "BUY",
      entry_price: 1.1674,
      target_entry_price: 1.1674,
      average_fill_price: null,
      quantity: 100.0,
      filled_quantity: 0,
      status: "OPEN",
      entry_status: "PENDING_ENTRY",
      exchange: "bybit",
      environment: "demo"
    });

    // Mock Bybit returning PartiallyFilled order
    mockFetchOrder.mockResolvedValue({
      id: "bybit_ord_12345",
      clientOrderId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      type: "limit",
      status: "partially_filled",
      price: new BigNumber(1.1674),
      average: new BigNumber(1.1674),
      amount: new BigNumber(100.0),
      filled: new BigNumber(45.0),
      remaining: new BigNumber(55.0)
    });

    const req = new Request(`http://bot/execution-status?positionId=${alertId}`, { method: "GET" });
    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const data = await res.json<any>();
    expect(data.success).toBe(true);
    expect(data.isFilled).toBe(false);
    expect(data.entryStatus).toBe("PARTIALLY_FILLED");
    expect(data.filledQuantity).toBe(45.0);
    expect(data.remainingQuantity).toBe(55.0);
  });

  it("reconciles order to FAILED / CANCELLED when Bybit reports order cancelled or rejected", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertId = "c3cbe99c-2750-49f0-91a8-0777be8c3fe2";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    mockStorage.set(`intent:order:${alertId}`, {
      intentId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      qty: "85.6604",
      status: "DISPATCHED",
      createdAt: Date.now(),
      reconciliationAttemptCount: 0
    });

    d1Positions.set(alertId, {
      id: alertId,
      user_id: userId,
      symbol: "ZRO/USDT",
      side: "BUY",
      entry_price: 1.1674,
      target_entry_price: 1.1674,
      average_fill_price: null,
      quantity: 85.6604,
      filled_quantity: 0,
      status: "OPEN",
      entry_status: "PENDING_ENTRY",
      exchange: "bybit",
      environment: "demo"
    });

    // Mock Bybit returning Cancelled order
    mockFetchOrder.mockResolvedValue({
      id: "bybit_ord_12345",
      clientOrderId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      type: "limit",
      status: "canceled",
      price: new BigNumber(1.1674),
      amount: new BigNumber(85.6604),
      filled: new BigNumber(0),
      remaining: new BigNumber(85.6604)
    });

    const req = new Request(`http://bot/execution-status?positionId=${alertId}`, { method: "GET" });
    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const data = await res.json<any>();
    expect(data.success).toBe(true);
    expect(data.isFilled).toBe(false);
    expect(data.isTerminal).toBe(true);
    expect(data.entryStatus).toBe("FAILED");

    // Verify D1 updated to CANCELLED
    const updatedPos = d1Positions.get(alertId);
    expect(updatedPos.status).toBe("CANCELLED");
    expect(updatedPos.entry_status).toBe("FAILED");
  });
});
