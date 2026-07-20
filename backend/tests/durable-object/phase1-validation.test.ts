import { describe, it, expect, vi, beforeEach } from "vitest";
import { getExchangeAdapter, normalizeQuantity } from "../../src/exchanges";
import { TradingBot } from "../../src/trading-bot";
import { DeltaExchange } from "./exchanges/DeltaExchange";
import { Env } from "../../src/index";

describe("Phase 1 Production Readiness Validation", () => {
  let mockStorage: any;
  let mockEnv: any;
  let mockFetch: any;

  beforeEach(() => {
    mockStorage = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      setAlarm: vi.fn(),
    };
    mockEnv = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              exchange_name: "delta",
              exchange_environment: "testnet",
              exchange_region: "india",
              exchange_api_key: "key",
              exchange_api_secret_iv: "iv",
              exchange_api_secret_encrypted: "encrypted",
            }),
            run: vi.fn().mockResolvedValue({ success: true }),
          }),
        }),
      },
      ENCRYPTION_KEY: "test_key",
    } as unknown as Env;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    
    // Mock crypto decryption
    vi.mock("./crypto", async (importOriginal) => {
      const mod = await importOriginal();
      return {
        ...(mod as any),
        decrypt: vi.fn().mockResolvedValue("decrypted_secret"),
      };
    });
  });

  describe("1. Concurrency Protection (blockConcurrencyWhile)", () => {
    it("should prevent concurrent trade executions", async () => {
      let activeLocks = 0;
      let maxLocks = 0;
      
      const mockState = {
        storage: mockStorage,
        blockConcurrencyWhile: vi.fn(async (cb: any) => {
          activeLocks++;
          maxLocks = Math.max(maxLocks, activeLocks);
          const result = await cb();
          activeLocks--;
          return result;
        })
      } as any;

      const bot = new TradingBot(mockState, mockEnv);
      bot["isExecutingTrade"] = true; // Simulate active execution lock
      
      const req = new Request("https://localhost/execute-trade", { method: "POST" });
      const res = await bot.fetch(req);
      
      expect(res.status).toBe(409);
      const json = await res.json() as any;
      expect(json.error).toBe("A trade execution is already in progress.");
    });
  });

  describe("2. Durable Object Recovery", () => {
    it("should recover isExecutingTrade state from storage on restart", async () => {
      mockStorage.get.mockResolvedValueOnce(true); // Simulate recovering 'isExecutingTrade = true'
      const mockState = {
        storage: mockStorage,
        blockConcurrencyWhile: vi.fn(async (cb: any) => cb()),
      } as any;

      const bot = new TradingBot(mockState, mockEnv);
      
      // Wait for the constructor's blockConcurrencyWhile to finish
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(bot["isExecutingTrade"]).toBe(true);
    });
  });

  describe("3. Trade Lifecycle State Management & TTL", () => {
    it("should expire stale pending alerts (60s TTL) during analysis cycle", async () => {
      // Create a stale alert (61 seconds old)
      const staleTimestamp = new Date(Date.now() - 61000).toISOString();
      const mockAlerts = [{ id: "1", status: "pending", timestamp: staleTimestamp, symbol: "BTCUSDT" }];
      
      mockStorage.get.mockImplementation((key: string) => {
        if (key === 'alerts') return mockAlerts;
        if (key === 'isActive') return true;
        if (key === 'coinId') return "BTCUSDT";
        if (key === 'userId') return "user-1";
        return null;
      });

      const mockState = {
        storage: mockStorage,
        blockConcurrencyWhile: vi.fn(async (cb: any) => cb()),
      } as any;
      const bot = new TradingBot(mockState, mockEnv);
      
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, result: [] })
      });
      // Mock fetch ticker to not fail
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('ticker')) return { ok: true, json: async () => ({ success: true, result: { symbol: 'BTCUSD', last_price: '60000', volume: '100' }}) };
        return { ok: true, json: async () => ({ success: true, result: [] }) };
      });

      await bot.alarm();
      
      // Verify alerts were updated (pruneAlerts removes non-pending alerts, so it should save [])
      expect(mockStorage.put).toHaveBeenCalledWith("alerts", []);
      // Verify logs
      expect(mockStorage.put).toHaveBeenCalledWith("logs", expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("expired") })
      ]));
    });
  });

  describe("4. Retry Policies & Exponential Backoff (fetchWithRetry)", () => {
    it("should retry on 429/500 errors and succeed", async () => {
      const adapter = getExchangeAdapter("delta", "testnet", "india") as DeltaExchange;
      
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 429 }) // 1st try fails
        .mockResolvedValueOnce({ ok: false, status: 500 }) // 2nd try fails
        .mockResolvedValueOnce({ 
          ok: true, 
          json: async () => ({ success: true, result: [{ symbol: "BTCUSD" }] }) 
        }); // 3rd try succeeds
        
      // Override delay for fast testing
      const result = await (adapter as any).fetchWithRetry("http://api.test", {}, 2, 10);
      
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result.ok).toBe(true);
    });
  });

  describe("5. Exchange Precision Validation", () => {
    it("should correctly round quantities using lotSize and tickSize", () => {
      const lotSize = 0.001; // e.g. BTC
      const minQty = 0.001;
      const maxQty = 1000;
      
      expect(normalizeQuantity(0.0035, lotSize, minQty, maxQty)).toBe(0.003);
      expect(normalizeQuantity(0.0001, lotSize, minQty, maxQty)).toBe(0.001); // clamped to minQty
      expect(normalizeQuantity(2000, lotSize, minQty, maxQty)).toBe(1000); // above max
    });
  });

  describe("6. Background Monitoring Fail-Safe (Immortal Alarm)", () => {
    it("should reschedule alarm even if analysis throws an exception", async () => {
      mockStorage.get.mockImplementation((key: string) => {
        if (key === 'isActive') return true;
        if (key === 'coinId') throw new Error("Simulated DB Crash");
        return null;
      });

      const mockState = {
        storage: mockStorage,
        blockConcurrencyWhile: vi.fn(async (cb: any) => cb()),
      } as any;
      const bot = new TradingBot(mockState, mockEnv);
      
      await bot.alarm();
      
      // Ensure setAlarm was still called in the finally block
      expect(mockStorage.setAlarm).toHaveBeenCalled();
    });
  });

  describe("7. Idempotent Order Execution (clientOrderId)", () => {
    it("should pass clientOrderId to exchange placeOrder", async () => {
      const adapter = getExchangeAdapter("delta", "testnet", "india") as DeltaExchange;
      
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: [] }) }) // Leverage
        .mockResolvedValueOnce({ 
          ok: true, 
          json: async () => ({ success: true, result: { id: "order-123", avg_price: "60000", quantity: "0.01" } }) 
        }); // Order
      
      // Mock metadata cache to bypass fetch
      (adapter as any).metadataCache = new Map([
        ["BTCUSD", { id: 1, minQty: 0.001, maxQty: 100, lotSize: 0.001, tickSize: 0.01 }]
      ]);
      (adapter as any).lastCacheFetch = Date.now();

      await adapter.placeOrder("BTC", "BUY", "key", "secret", 0.01, "unique-alert-123");
      
      // Check that client_order_id was included in the fetch body
      const orderCall = mockFetch.mock.calls.find((c: any) => c[0].endsWith("/v2/orders"));
      const body = JSON.parse(orderCall[1].body);
      expect(body.client_order_id).toBe("unique-alert-123");
    });
  });
});
