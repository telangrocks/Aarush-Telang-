import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";
import BigNumber from "bignumber.js";

// Mock security crypto
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key")
}));

// Mock exchanges adapter
const mockFetchTicker = vi.fn();
const mockFetchPositions = vi.fn();
const mockFetchClosedPnl = vi.fn();
const mockCreateOrder = vi.fn();

vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: (...args: any[]) => mockFetchTicker(...args),
        fetchPositions: (...args: any[]) => mockFetchPositions(...args),
        fetchClosedPnl: (...args: any[]) => mockFetchClosedPnl(...args),
        createOrder: (...args: any[]) => mockCreateOrder(...args),
        fetchMarkets: vi.fn().mockResolvedValue([]),
        fetchBalance: vi.fn().mockResolvedValue({ total: { USDT: 1000 } }),
      }),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('demo'),
    resolveCanonicalRoutingRegion: vi.fn().mockReturnValue('global'),
  };
});

describe("Phase 2E — Mock-Only Monitoring Isolation Adversarial Tests", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let d1Positions: Map<string, any>;
  let capturedD1Updates: any[];

  beforeEach(() => {
    mockStorage = new Map();
    d1Positions = new Map();
    capturedD1Updates = [];
    mockFetchTicker.mockReset();
    mockFetchPositions.mockReset();
    mockFetchClosedPnl.mockReset();
    mockCreateOrder.mockReset();

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
              capturedD1Updates.push({ query, args });
              if (query.includes('UPDATE trade_positions') && query.includes("SET status = 'CLOSED'")) {
                const id = args[5] || args[6];
                const pos = d1Positions.get(id);
                if (pos) {
                  pos.status = 'CLOSED';
                  pos.closed_at = args[0];
                  pos.close_price = args[1];
                  pos.realized_pnl = args[2];
                  pos.close_reason = args[3];
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

  it("1. Mock position + SL breach: local close is ALLOWED", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const posId = "mock_pos_sl";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    mockStorage.set('activePositions', [
      {
        id: posId,
        symbol: "ZRO/USDT",
        side: "BUY",
        entryPrice: 1.1674,
        stopLoss: 1.14989,
        takeProfit: 1.20242,
        quantity: 85.6604,
        exchange: "mock",
        environment: "demo"
      }
    ]);

    d1Positions.set(posId, { id: posId, status: "OPEN" });

    // Price breaches SL (1.1000 <= 1.14989)
    mockFetchTicker.mockResolvedValue({
      symbol: "ZRO/USDT",
      last: new BigNumber(1.1000)
    });

    await (bot as any).monitorOpenPositions();

    // Verify D1 closed
    const updatedPos = d1Positions.get(posId);
    expect(updatedPos.status).toBe("CLOSED");
    expect(updatedPos.close_reason).toBe("stop_loss");
    expect(updatedPos.close_price).toBe(1.1000);

    // Verify removed from DO activePositions
    const remainingActive = mockStorage.get('activePositions');
    expect(remainingActive.length).toBe(0);

    // Verify NO exchange order was submitted
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("2. Mock position + TP breach: local close is ALLOWED", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const posId = "mock_pos_tp";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    mockStorage.set('activePositions', [
      {
        id: posId,
        symbol: "ZRO/USDT",
        side: "BUY",
        entryPrice: 1.1674,
        stopLoss: 1.14989,
        takeProfit: 1.20242,
        quantity: 85.6604,
        exchange: "mock",
        environment: "demo"
      }
    ]);

    d1Positions.set(posId, { id: posId, status: "OPEN" });

    // Price breaches TP (1.2500 >= 1.20242)
    mockFetchTicker.mockResolvedValue({
      symbol: "ZRO/USDT",
      last: new BigNumber(1.2500)
    });

    await (bot as any).monitorOpenPositions();

    const updatedPos = d1Positions.get(posId);
    expect(updatedPos.status).toBe("CLOSED");
    expect(updatedPos.close_reason).toBe("take_profit");
    expect(updatedPos.close_price).toBe(1.2500);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("3. Bybit Demo + SL breach: strictly NO local close (Bybit owns position)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const posId = "bybit_demo_sl";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    mockStorage.set('activePositions', [
      {
        id: posId,
        symbol: "ZRO/USDT",
        side: "BUY",
        entryPrice: 1.1674,
        stopLoss: 1.14989,
        takeProfit: 1.20242,
        quantity: 85.6604,
        exchange: "bybit", // Bybit Demo
        environment: "demo"
      }
    ]);

    d1Positions.set(posId, { id: posId, status: "OPEN" });

    mockFetchTicker.mockResolvedValue({
      symbol: "ZRO/USDT",
      last: new BigNumber(1.1000) // Breaches SL
    });

    await (bot as any).monitorOpenPositions();

    // Verify D1 status is STILL OPEN
    const pos = d1Positions.get(posId);
    expect(pos.status).toBe("OPEN");
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("4. Bybit Demo + TP breach: strictly NO local close", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const posId = "bybit_demo_tp";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    mockStorage.set('activePositions', [
      {
        id: posId,
        symbol: "ZRO/USDT",
        side: "BUY",
        entryPrice: 1.1674,
        stopLoss: 1.14989,
        takeProfit: 1.20242,
        quantity: 85.6604,
        exchange: "bybit",
        environment: "demo"
      }
    ]);

    d1Positions.set(posId, { id: posId, status: "OPEN" });

    mockFetchTicker.mockResolvedValue({
      symbol: "ZRO/USDT",
      last: new BigNumber(1.3000) // Breaches TP
    });

    await (bot as any).monitorOpenPositions();

    const pos = d1Positions.get(posId);
    expect(pos.status).toBe("OPEN");
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("5. Bybit Real + SL breach: strictly NO local close", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const posId = "bybit_real_sl";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    mockStorage.set('activePositions', [
      {
        id: posId,
        symbol: "BTC/USDT",
        side: "BUY",
        entryPrice: 60000,
        stopLoss: 58000,
        takeProfit: 65000,
        quantity: 0.1,
        exchange: "bybit",
        environment: "mainnet" // Real Mainnet
      }
    ]);

    d1Positions.set(posId, { id: posId, status: "OPEN" });

    mockFetchTicker.mockResolvedValue({
      symbol: "BTC/USDT",
      last: new BigNumber(55000) // Breaches SL
    });

    await (bot as any).monitorOpenPositions();

    const pos = d1Positions.get(posId);
    expect(pos.status).toBe("OPEN");
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("6. Bybit Real + TP breach: strictly NO local close", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const posId = "bybit_real_tp";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    mockStorage.set('activePositions', [
      {
        id: posId,
        symbol: "BTC/USDT",
        side: "BUY",
        entryPrice: 60000,
        stopLoss: 58000,
        takeProfit: 65000,
        quantity: 0.1,
        exchange: "bybit",
        environment: "mainnet"
      }
    ]);

    d1Positions.set(posId, { id: posId, status: "OPEN" });

    mockFetchTicker.mockResolvedValue({
      symbol: "BTC/USDT",
      last: new BigNumber(70000) // Breaches TP
    });

    await (bot as any).monitorOpenPositions();

    const pos = d1Positions.get(posId);
    expect(pos.status).toBe("OPEN");
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });
});
