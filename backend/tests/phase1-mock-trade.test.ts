import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../src/trading-bot";

// Mock security crypto
vi.mock("../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key")
}));

// Mock exchanges adapter
vi.mock("../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({
          symbol: 'ZRO/USDT',
          last: { toNumber: () => 1.1674 }
        }),
        fetchMarkets: vi.fn().mockResolvedValue([
          {
            symbol: 'ZRO/USDT',
            id: 'ZROUSDT',
            precision: { amount: 0.0001, price: 0.0001 },
            limits: { cost: { min: 5 }, amount: { min: 0.0001 } }
          }
        ]),
      }),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('demo'),
    resolveCanonicalRoutingRegion: vi.fn().mockReturnValue('global'),
  };
});

describe("Phase 1 — Mock Trade Execution Contract Tests", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let mockDb: any;
  let d1Insertions: any[];

  beforeEach(() => {
    mockStorage = new Map();
    d1Insertions = [];

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

    mockDb = {
      prepare: vi.fn().mockImplementation((query: string) => ({
        bind: vi.fn().mockImplementation((...args: any[]) => ({
          run: vi.fn().mockImplementation(async () => {
            if (query.includes('INSERT INTO trade_positions')) {
              d1Insertions.push({ query, args });
            }
            return { success: true };
          }),
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'demo',
            exchange_region: 'global',
          }),
          all: vi.fn().mockResolvedValue({ results: [] })
        }))
      }))
    };

    mockEnv = {
      DB: mockDb,
      GLOBAL_TRADING_HALT: "false"
    };
  });

  it("successfully executes mock trade with complete authorative payload", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'usr_test_123');

    const alertId = "c3cbe99c-2750-49f0-91a8-0777be8c3fe2";
    const payload = {
      alertId,
      symbol: "ZRO/USDT",
      side: "BUY",
      orderType: "MARKET",
      targetEntryPrice: 1.1674,
      signalPrice: 1.1674,
      stopLoss: 1.14989,
      takeProfit: 1.20242,
      positionSizeUsdt: 100.0,
      strategy: "ScalperV2",
      isMockTrade: true
    };

    const req = new Request("http://bot/mock-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const data = await res.json<any>();
    expect(data.success).toBe(true);
    expect(data.isMockTrade).toBe(true);
    expect(data.alertId).toBe(alertId);
    expect(data.symbol).toBe("ZRO/USDT");
    expect(data.side).toBe("BUY");
    expect(data.executionPrice).toBe(1.1674);
    expect(data.stopLoss).toBe(1.14989);
    expect(data.takeProfit).toBe(1.20242);
    expect(data.positionSizeUsdt).toBe(100.0);
    expect(data.strategy).toBe("ScalperV2");

    // Check D1 persistence
    expect(d1Insertions.length).toBe(1);
    const d1Record = d1Insertions[0];
    expect(d1Record.args[1]).toBe("usr_test_123"); // user_id
    expect(d1Record.args[2]).toBe("ZRO/USDT");     // symbol
    expect(d1Record.args[3]).toBe("BUY");          // side
    expect(d1Record.args[4]).toBe(1.1674);         // entry_price
    expect(d1Record.args[5]).toBe(1.1674);         // target_entry_price
    expect(d1Record.args[7]).toBe(1.14989);        // stop_loss
    expect(d1Record.args[8]).toBe(1.20242);        // take_profit
    expect(d1Record.args[9]).toBe("OPEN");         // status
    expect(d1Record.args[10]).toBe("FILLED");      // entry_status
    expect(d1Record.args[16]).toBe("ScalperV2");   // strategy

    // Check DO storage activePositions
    const activePositions = mockStorage.get('activePositions');
    expect(activePositions).toBeDefined();
    expect(activePositions.length).toBe(1);
    expect(activePositions[0].alertId).toBe(alertId);
    expect(activePositions[0].symbol).toBe("ZRO/USDT");
    expect(activePositions[0].stopLoss).toBe(1.14989);
    expect(activePositions[0].takeProfit).toBe(1.20242);
    expect(activePositions[0].entryPrice).toBe(1.1674);
    expect(activePositions[0].strategy).toBe("ScalperV2");

    // Check Idempotency key stored
    const intent = mockStorage.get(`intent:order:${alertId}`);
    expect(intent).toBeDefined();
    expect(intent.status).toBe("FILLED");
  });

  it("rejects duplicate execution with same alertId via Idempotency Guard (409 Conflict)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'usr_test_123');

    const alertId = "c3cbe99c-2750-49f0-91a8-0777be8c3fe2";
    mockStorage.set(`intent:order:${alertId}`, {
      id: "mock_existing_123",
      alertId,
      symbol: "ZRO/USDT",
      status: "FILLED"
    });

    const payload = {
      alertId,
      symbol: "ZRO/USDT",
      side: "BUY",
      stopLoss: 1.14989,
      takeProfit: 1.20242,
      positionSizeUsdt: 100.0,
      strategy: "ScalperV2",
      isMockTrade: true
    };

    const req = new Request("http://bot/mock-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(409);

    const data = await res.json<any>();
    expect(data.success).toBe(false);
    expect(data.errorCode).toBe("DUPLICATE_ORDER");
  });

  it("rejects invalid directional Stop Loss (400 Bad Request)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'usr_test_123');

    const payload = {
      alertId: "alert_invalid_sl",
      symbol: "ZRO/USDT",
      side: "BUY",
      stopLoss: 1.50, // Invalid: SL above entry price (1.1674) for BUY
      takeProfit: 1.60,
      positionSizeUsdt: 100.0,
      strategy: "ScalperV2",
      isMockTrade: true
    };

    const req = new Request("http://bot/mock-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(400);

    const data = await res.json<any>();
    expect(data.success).toBe(false);
    expect(data.message).toContain("Invalid Stop Loss");
  });

  it("rejects order when notional is below minimum (400 Bad Request via TradeValidator)", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    mockStorage.set('userId', 'usr_test_123');

    const payload = {
      alertId: "alert_low_notional",
      symbol: "ZRO/USDT",
      side: "BUY",
      stopLoss: 1.10,
      takeProfit: 1.30,
      positionSizeUsdt: 1.0, // Below minNotional of 5 USDT
      strategy: "ScalperV2",
      isMockTrade: true
    };

    const req = new Request("http://bot/mock-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const res = await bot.fetch(req);
    expect(res.status).toBe(400);

    const data = await res.json<any>();
    expect(data.success).toBe(false);
    expect(data.errorCode).toBe("MIN_NOTIONAL_FAILED");
  });
});
