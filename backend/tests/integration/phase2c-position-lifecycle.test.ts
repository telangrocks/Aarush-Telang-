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
const mockFetchPositions = vi.fn();
const mockFetchClosedPnl = vi.fn();
const mockFetchTicker = vi.fn();

vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchOrder: (...args: any[]) => mockFetchOrder(...args),
        fetchClosedOrders: (...args: any[]) => mockFetchClosedOrders(...args),
        fetchMyTrades: (...args: any[]) => mockFetchMyTrades(...args),
        fetchPositions: (...args: any[]) => mockFetchPositions(...args),
        fetchClosedPnl: (...args: any[]) => mockFetchClosedPnl(...args),
        fetchTicker: (...args: any[]) => mockFetchTicker(...args),
      }),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('demo'),
    resolveCanonicalRoutingRegion: vi.fn().mockReturnValue('global'),
  };
});

describe("Phase 2C — Exchange-Native Position & TP/SL Lifecycle Reconciliation Tests", () => {
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
    mockFetchPositions.mockReset();
    mockFetchClosedPnl.mockReset();
    mockFetchTicker.mockReset();

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
              if (query.includes('UPDATE trade_positions') && query.includes("SET status = 'CLOSED'")) {
                const id = args[5] || args[6];
                const pos = d1Positions.get(id);
                if (pos && pos.status === 'OPEN') {
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

  it("reconciles Bybit TP-triggered exit to CLOSED with authoritative realized P&L", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertId = "c3cbe99c-2750-49f0-91a8-0777be8c3fe2";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    mockStorage.set(`intent:order:${alertId}`, {
      intentId: alertId,
      symbol: "ZRO/USDT",
      side: "buy",
      status: "FILLED",
      actualFillPrice: "1.1674",
      actualExecutedQuantity: "85.6604"
    });

    d1Positions.set(alertId, {
      id: alertId,
      user_id: userId,
      symbol: "ZRO/USDT",
      side: "BUY",
      entry_price: 1.1674,
      target_entry_price: 1.1674,
      average_fill_price: 1.1674,
      quantity: 85.6604,
      filled_quantity: 85.6604,
      stop_loss: 1.14989,
      take_profit: 1.20242,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo"
    });

    // 1. Bybit positions query returns 0 (position closed)
    mockFetchPositions.mockResolvedValue([]);

    // 2. Bybit closed-pnl query returns authoritative TP exit record
    mockFetchClosedPnl.mockResolvedValue([
      {
        symbol: "ZRO/USDT",
        orderId: "bybit_tp_exit_999",
        side: "sell",
        qty: 85.6604,
        orderType: "Market",
        execType: "Trade",
        closedPnl: 3.00,
        avgEntryPrice: 1.1674,
        avgExitPrice: 1.20242,
        updatedTime: 1787467800000
      }
    ]);

    const req = new Request(`http://bot/execution-status?positionId=${alertId}`, { method: "GET" });
    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    // Verify D1 record updated to CLOSED with exact Bybit data
    const updatedPos = d1Positions.get(alertId);
    expect(updatedPos.status).toBe("CLOSED");
    expect(updatedPos.close_price).toBe(1.20242);
    expect(updatedPos.realized_pnl).toBe(3.00);
    expect(updatedPos.close_reason).toBe("take_profit");
  });

  it("reconciles Bybit SL-triggered exit to CLOSED with authoritative realized P&L", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertId = "c3cbe99c-2750-49f0-91a8-0777be8c3fe2";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    d1Positions.set(alertId, {
      id: alertId,
      user_id: userId,
      symbol: "ZRO/USDT",
      side: "BUY",
      entry_price: 1.1674,
      target_entry_price: 1.1674,
      average_fill_price: 1.1674,
      quantity: 85.6604,
      filled_quantity: 85.6604,
      stop_loss: 1.14989,
      take_profit: 1.20242,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo"
    });

    mockFetchPositions.mockResolvedValue([]);
    mockFetchClosedPnl.mockResolvedValue([
      {
        symbol: "ZRO/USDT",
        orderId: "bybit_sl_exit_888",
        side: "sell",
        qty: 85.6604,
        orderType: "Market",
        execType: "Trade",
        closedPnl: -1.50,
        avgEntryPrice: 1.1674,
        avgExitPrice: 1.14989,
        updatedTime: 1787467900000
      }
    ]);

    const req = new Request(`http://bot/execution-status?positionId=${alertId}`, { method: "GET" });
    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const updatedPos = d1Positions.get(alertId);
    expect(updatedPos.status).toBe("CLOSED");
    expect(updatedPos.close_price).toBe(1.14989);
    expect(updatedPos.realized_pnl).toBe(-1.50);
    expect(updatedPos.close_reason).toBe("stop_loss");
  });

  it("reconciles manual closure on Bybit app as close_reason = 'manual'", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertId = "c3cbe99c-2750-49f0-91a8-0777be8c3fe2";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    d1Positions.set(alertId, {
      id: alertId,
      user_id: userId,
      symbol: "ZRO/USDT",
      side: "BUY",
      entry_price: 1.1674,
      average_fill_price: 1.1674,
      quantity: 85.6604,
      filled_quantity: 85.6604,
      stop_loss: 1.14989,
      take_profit: 1.20242,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo"
    });

    mockFetchPositions.mockResolvedValue([]);
    mockFetchClosedPnl.mockResolvedValue([
      {
        symbol: "ZRO/USDT",
        orderId: "bybit_manual_exit_777",
        side: "sell",
        qty: 85.6604,
        orderType: "Market",
        execType: "Trade",
        closedPnl: 0.85,
        avgEntryPrice: 1.1674,
        avgExitPrice: 1.1770, // Manual exit between SL and TP
        updatedTime: 1787467950000
      }
    ]);

    const req = new Request(`http://bot/execution-status?positionId=${alertId}`, { method: "GET" });
    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const updatedPos = d1Positions.get(alertId);
    expect(updatedPos.status).toBe("CLOSED");
    expect(updatedPos.close_price).toBe(1.1770);
    expect(updatedPos.realized_pnl).toBe(0.85);
    expect(updatedPos.close_reason).toBe("manual");
  });

  it("CRITICAL INVARIANT PROOF: monitorOpenPositions strictly ignores Bybit positions even if ticker breaches SL", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const alertId = "c3cbe99c-bybit-live-pos";
    const userId = "usr_test_123";

    mockStorage.set('userId', userId);
    // Put a Bybit position in activePositions
    mockStorage.set('activePositions', [
      {
        id: alertId,
        symbol: "ZRO/USDT",
        side: "BUY",
        entry_price: 1.1674,
        stop_loss: 1.14989,
        take_profit: 1.20242,
        quantity: 85.6604,
        exchange: "bybit", // NOT 'mock'
        environment: "demo"
      }
    ]);

    d1Positions.set(alertId, {
      id: alertId,
      status: "OPEN"
    });

    // Mock ticker breaching SL
    mockFetchTicker.mockResolvedValue({
      symbol: "ZRO/USDT",
      last: new BigNumber(1.1000) // Dropped below SL 1.14989
    });

    // Invoke monitorOpenPositions via alarm handler
    await (bot as any).monitorOpenPositions();

    // Verify D1 was NOT mutated by local monitor!
    const pos = d1Positions.get(alertId);
    expect(pos.status).toBe("OPEN"); // Still OPEN in D1 (local monitor did not close it)
  });
});
