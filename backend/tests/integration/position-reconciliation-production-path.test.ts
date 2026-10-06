import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";
import { ExchangeManager } from "../../src/exchanges";
import BigNumber from "bignumber.js";

// Mock security crypto decrypt
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key"),
  encrypt: vi.fn().mockResolvedValue({ iv: 'iv', encrypted: 'enc', salt: 'salt' }),
  cleanCredential: vi.fn().mockImplementation((k: string) => k)
}));

describe("Position Reconciliation Production Path Integration Tests", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let d1Positions: Map<string, any>;
  let mockFetchPositions: any;
  let mockFetchClosedPnl: any;
  let mockCreateOrder: any;

  const userId = "usr_test_recon_prod";
  const alertId = "alert_recon_test_001";

  beforeEach(() => {
    mockStorage = new Map();
    d1Positions = new Map();

    mockFetchPositions = vi.fn();
    mockFetchClosedPnl = vi.fn().mockResolvedValue([]);
    mockCreateOrder = vi.fn().mockResolvedValue({
      id: "bybit_ord_success",
      symbol: "SOPH/USDT",
      amount: "100"
    });

    // Durable Object Storage mock
    mockState = {
      id: { toString: () => "mock-trading-bot-do-id" },
      storage: {
        get: async (key: string) => mockStorage.get(key),
        put: async (key: string, val: any) => mockStorage.set(key, val),
        delete: async (key: string) => mockStorage.delete(key),
        setAlarm: vi.fn(),
        list: async () => mockStorage,
        transaction: async (cb: any) => cb({
          get: async (key: string) => mockStorage.get(key),
          put: async (key: string, val: any) => mockStorage.set(key, val),
          delete: async (key: string) => mockStorage.delete(key)
        })
      },
      blockConcurrencyWhile: async (cb: any) => cb(),
      waitUntil: vi.fn()
    };

    // D1 Database mock with exact SQL query handling
    mockEnv = {
      DB: {
        prepare: vi.fn().mockImplementation((query: string) => ({
          bind: vi.fn().mockImplementation((...args: any[]) => ({
            run: vi.fn().mockImplementation(async () => {
              if (query.includes('UPDATE trade_positions') && query.includes("SET status = 'CLOSED'")) {
                // UPDATE trade_positions SET status = 'CLOSED', closed_at = ?, close_price = ?, realized_pnl = ?, close_reason = ?, updated_at = ? WHERE id = ?
                const id = args[5];
                const pos = d1Positions.get(id);
                if (pos) {
                  pos.status = 'CLOSED';
                  pos.closed_at = args[0];
                  pos.close_price = args[1];
                  pos.realized_pnl = args[2];
                  pos.close_reason = args[3];
                  pos.updated_at = args[4];
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
                  exchange_api_key: 'test_key',
                  exchange_api_secret_encrypted: 'mock_enc',
                  exchange_api_secret_iv: 'mock_iv',
                  exchange_api_secret_salt: 'mock_salt'
                };
              }
              if (query.includes('FROM trade_positions')) {
                const id = args[0];
                return d1Positions.get(id) || null;
              }
              return null;
            }),
            all: vi.fn().mockImplementation(async () => {
              if (query.includes('FROM trade_positions WHERE user_id = ? AND status IN')) {
                const active = Array.from(d1Positions.values()).filter(
                  p => p.status === 'OPEN' || p.status === 'PENDING_ENTRY'
                );
                return { results: active };
              }
              return { results: [] };
            })
          })),
          first: vi.fn().mockImplementation(async () => null),
          all: vi.fn().mockImplementation(async () => {
            if (query.includes("PRAGMA table_info('trade_positions')")) {
              return {
                results: [
                  { name: 'target_entry_price' },
                  { name: 'entry_status' }
                ]
              };
            }
            return { results: [] };
          })
        }))
      },
      ENCRYPTION_KEY: "test_encryption_key",
      COOKIE_ENCRYPTION_KEY: "test_encryption_key",
      GLOBAL_TRADING_HALT: "false"
    };

    // Mock Bybit Exchange Provider
    vi.spyOn(ExchangeManager, "getProvider").mockResolvedValue({
      fetchPositions: (...args: any[]) => mockFetchPositions(...args),
      fetchClosedPnl: (...args: any[]) => mockFetchClosedPnl(...args),
      fetchBalance: vi.fn().mockResolvedValue([
        { currency: "USDT", free: new BigNumber(10000), total: new BigNumber(10000), used: new BigNumber(0) }
      ]),
      fetchTicker: vi.fn().mockResolvedValue({ last: 0.005969 }),
      fetchMarkets: vi.fn().mockResolvedValue([
        {
          id: "SOPHUSDT",
          symbol: "SOPH/USDT",
          base: "SOPH",
          quote: "USDT",
          category: "linear",
          precision: { price: 0.000001, amount: 10 },
          limits: {
            price: { min: new BigNumber(0.000001), max: new BigNumber(1000) },
            amount: { min: new BigNumber(10), max: new BigNumber(1000000) },
            cost: { min: new BigNumber(5) }
          }
        }
      ]),
      createOrder: (...args: any[]) => mockCreateOrder(...args)
    } as any);
  });

  const baseTradeAlert = {
    id: alertId,
    symbol: "SOPH/USDT",
    strategy: "ScalperV2",
    side: "BUY" as const,
    entryIntent: "IMMEDIATE",
    entryPrice: 0.005969,
    stopLoss: 0.005748,
    takeProfit: 0.006411,
    positionSize: 25.00,
    timestamp: new Date().toISOString(),
    status: "pending"
  };

  async function setupAndExecuteBot(initialD1Positions: any[]): Promise<Response> {
    for (const p of initialD1Positions) {
      d1Positions.set(p.id, { ...p });
    }

    mockStorage.set("userId", userId);
    mockStorage.set("strategy", "ScalperV2");
    mockStorage.set("alerts", [baseTradeAlert]);

    // Instantiate REAL TradingBot Durable Object
    const bot = new TradingBot(mockState, mockEnv);

    // Invoke the REAL TradingBot.fetch() handling POST /execute-trade
    const req = new Request("http://bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertId, action: "CONFIRM" })
    });

    return await bot.fetch(req);
  }

  // 1. One D1 OPEN + one matching Bybit position → remains OPEN
  it("Case 1: One D1 OPEN + one matching Bybit position remains OPEN through production path", async () => {
    mockFetchPositions.mockResolvedValue([
      { symbol: "SOPHUSDT", side: "long", size: new BigNumber(100) }
    ]);

    const initialPositions = [
      { id: "pos-1", user_id: userId, symbol: "SOPH/USDT", side: "BUY", status: "OPEN", exchange: "bybit" }
    ];

    const res = await setupAndExecuteBot(initialPositions);

    // Verify fetchPositions was actually called with 'linear' by TradingBot.fetch()
    expect(mockFetchPositions).toHaveBeenCalledWith("linear");

    // D1 row MUST remain OPEN
    const pos1 = d1Positions.get("pos-1");
    expect(pos1.status).toBe("OPEN");
  });

  // 2. Two D1 OPEN rows with identical symbol + side + one Bybit net position
  // → BOTH remain OPEN. Verify the older row is NOT closed.
  it("Case 2: Two D1 OPEN rows, identical symbol + side, one Bybit net position → BOTH remain OPEN (older row NOT closed)", async () => {
    mockFetchPositions.mockResolvedValue([
      { symbol: "SOPHUSDT", side: "long", size: new BigNumber(100) }
    ]);
    mockFetchClosedPnl.mockResolvedValue([]);

    const initialPositions = [
      { id: "pos-old", user_id: userId, symbol: "SOPH/USDT", side: "BUY", status: "OPEN", exchange: "bybit", created_at: "2026-09-28T10:00:00Z" },
      { id: "pos-new", user_id: userId, symbol: "SOPH/USDT", side: "BUY", status: "OPEN", exchange: "bybit", created_at: "2026-10-01T10:00:00Z" }
    ];

    const res = await setupAndExecuteBot(initialPositions);

    // Verify TradingBot executed fetchPositions
    expect(mockFetchPositions).toHaveBeenCalledWith("linear");

    // Both rows MUST remain OPEN; older row is NOT closed
    const posOld = d1Positions.get("pos-old");
    const posNew = d1Positions.get("pos-new");
    expect(posOld.status).toBe("OPEN");
    expect(posNew.status).toBe("OPEN");
  });

  // 3. Two D1 rows + authoritative fetchPositions('linear') = []
  // → BOTH become CLOSED through the actual production path
  it("Case 3: Two D1 rows + authoritative Bybit empty list [] → BOTH become CLOSED via production path", async () => {
    mockFetchPositions.mockResolvedValue([]);
    mockFetchClosedPnl.mockResolvedValue([
      { symbol: "SOPH/USDT", orderId: "ord-exit", avgExitPrice: 0.0062, closedPnl: 5.5, updatedTime: 1727780000000 }
    ]);

    const initialPositions = [
      { id: "pos-1", user_id: userId, symbol: "SOPH/USDT", side: "BUY", status: "OPEN", exchange: "bybit" },
      { id: "pos-2", user_id: userId, symbol: "SOPH/USDT", side: "BUY", status: "OPEN", exchange: "bybit" }
    ];

    const res = await setupAndExecuteBot(initialPositions);

    // Verify TradingBot queried Bybit
    expect(mockFetchPositions).toHaveBeenCalledWith("linear");

    // Both positions MUST be reconciled to CLOSED in D1
    const pos1 = d1Positions.get("pos-1");
    const pos2 = d1Positions.get("pos-2");
    expect(pos1.status).toBe("CLOSED");
    expect(pos2.status).toBe("CLOSED");
  });

  // 4. fetchPositions('linear') throws → ZERO D1 rows are changed
  // This specifically protects against the original catch(() => []) defect
  it("Case 4: fetchPositions('linear') throws → ZERO D1 rows are changed (protects against catch(() => []))", async () => {
    mockFetchPositions.mockRejectedValue(new Error("Bybit 504 Gateway Timeout / Network Disconnect"));

    const initialPositions = [
      { id: "pos-1", user_id: userId, symbol: "SOPH/USDT", side: "BUY", status: "OPEN", exchange: "bybit" },
      { id: "pos-2", user_id: userId, symbol: "SOPH/USDT", side: "BUY", status: "OPEN", exchange: "bybit" }
    ];

    const res = await setupAndExecuteBot(initialPositions);

    // Verify TradingBot attempted fetchPositions
    expect(mockFetchPositions).toHaveBeenCalledWith("linear");

    // ZERO D1 rows may be closed on exchange failure
    const pos1 = d1Positions.get("pos-1");
    const pos2 = d1Positions.get("pos-2");
    expect(pos1.status).toBe("OPEN");
    expect(pos2.status).toBe("OPEN");
  });

  // 5. D1 BUY + Bybit SHORT → BUY is NOT validated by SHORT
  it("Case 5: D1 BUY + Bybit SHORT → BUY is NOT validated by SHORT and is closed as absent on long side", async () => {
    // Exchange has a SHORT position, but D1 has a BUY position
    mockFetchPositions.mockResolvedValue([
      { symbol: "SOPHUSDT", side: "short", size: new BigNumber(50) }
    ]);
    mockFetchClosedPnl.mockResolvedValue([
      { symbol: "SOPH/USDT", avgExitPrice: 0.0058, closedPnl: -1.2, updatedTime: 1727780000000 }
    ]);

    const initialPositions = [
      { id: "pos-buy", user_id: userId, symbol: "SOPH/USDT", side: "BUY", status: "OPEN", exchange: "bybit" }
    ];

    const res = await setupAndExecuteBot(initialPositions);

    expect(mockFetchPositions).toHaveBeenCalledWith("linear");

    // The BUY position is NOT validated by the SHORT position; recognized as closed on long side
    const posBuy = d1Positions.get("pos-buy");
    expect(posBuy.status).toBe("CLOSED");
  });

  // 6. Two D1 rows + one Bybit position + fetchClosedPnl() contains orderId matching only one D1 order_id
  // → only that specific D1 row becomes CLOSED; the other remains OPEN
  it("Case 6: Two D1 rows + one Bybit position + unique closed-PnL match → ONLY proven row closes, other remains OPEN", async () => {
    mockFetchPositions.mockResolvedValue([
      { symbol: "SOPHUSDT", side: "long", size: new BigNumber(50) }
    ]);

    // Closed-PnL uniquely records ord-closed-specific as closed
    mockFetchClosedPnl.mockResolvedValue([
      { symbol: "SOPH/USDT", orderId: "ord-closed-specific", avgExitPrice: 0.0063, closedPnl: 8.2, updatedTime: 1727785000000 }
    ]);

    const initialPositions = [
      { id: "pos-closed", user_id: userId, symbol: "SOPH/USDT", side: "BUY", status: "OPEN", order_id: "ord-closed-specific", exchange: "bybit" },
      { id: "pos-active", user_id: userId, symbol: "SOPH/USDT", side: "BUY", status: "OPEN", order_id: "ord-still-live", exchange: "bybit" }
    ];

    const res = await setupAndExecuteBot(initialPositions);

    expect(mockFetchPositions).toHaveBeenCalledWith("linear");

    // ONLY the uniquely proven row is closed
    const posClosed = d1Positions.get("pos-closed");
    const posActive = d1Positions.get("pos-active");
    expect(posClosed.status).toBe("CLOSED");
    expect(posClosed.close_price).toBe(0.0063);
    expect(posClosed.realized_pnl).toBe(8.2);

    // The other ambiguous row MUST remain OPEN
    expect(posActive.status).toBe("OPEN");
  });
});
