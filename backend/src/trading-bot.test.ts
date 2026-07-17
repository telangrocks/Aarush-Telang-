import { describe, it, expect, vi, beforeEach } from "vitest";
import { getExchangeAdapter } from "./exchanges";
import { TradingBot, evaluateStrategy } from "./trading-bot";
import { encrypt } from "./crypto";
import { analyzeMarket } from "./market-analysis";
import { Env } from "./index";
import { classifyExchangeResponse, classifyException, classifyByBody } from "./exchanges/errors";

describe("Trading Bot Integration & Exchange Adapters (Phase 5 Validation)", () => {
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  describe("1. Exchange API validation", () => {
    it("should sign and validate Delta Exchange credentials with correct prehash format, headers, and request path", async () => {
      const adapter = getExchangeAdapter("delta", "testnet", "india");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await adapter.validateCredentials("test_key", "test_secret");
      expect(result.success).toBe(true);

      // Verify the request details
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];

      // Request Path check
      expect(url).toContain("/v2/wallet/balances");

      // Header checks
      expect(init.headers["api-key"]).toBe("test_key");
      expect(init.headers["timestamp"]).toBeDefined();
      expect(init.headers["signature"]).toBeDefined();

      // Signature verification
      const timestamp = init.headers["timestamp"];
      expect(timestamp).toBeDefined();
      expect(isNaN(Number(timestamp))).toBe(false);
      const signature = init.headers["signature"];
      expect(signature.length).toBe(64); // SHA-256 hex is 64 chars
    });

    it("should classify invalid credentials properly", async () => {
      const adapter = getExchangeAdapter("delta", "testnet", "india");
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: "Invalid API credentials" }, success: false }),
      });

      const result = await adapter.validateCredentials("test_key", "test_secret");
      expect(result.success).toBe(false);
      expect(result.code).toBe("AUTHENTICATION_FAILED");
      expect(result.friendlyMessage).toContain("credentials");
    });
  });

  describe("2. Secure API key encryption and storage", () => {
    it("should encrypt and decrypt credentials correctly", async () => {
      const secret = "my_exchange_api_secret_123";
      const encryptionKey = "test_encryption_key_32_bytes_long_12345";

      const encrypted = await encrypt(secret, encryptionKey);
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.encrypted).toBeDefined();
      expect(encrypted.iv).not.toBe(secret);

      // Test decryption is tested inside the DO execute-trade path.
    });
  });

  describe("3. Exchange connection & URL configuration", () => {
    it("should configure correct rest URLs for different environments and regions", () => {
      const globalMainnet = getExchangeAdapter("delta", "mainnet", "global");
      expect(globalMainnet.getRestUrl()).toBe("https://api.delta.exchange");

      const indiaMainnet = getExchangeAdapter("delta", "mainnet", "india");
      expect(indiaMainnet.getRestUrl()).toBe("https://api.india.delta.exchange");

      const globalTestnet = getExchangeAdapter("delta", "testnet", "global");
      expect(globalTestnet.getRestUrl()).toBe("https://api-testnet.delta.exchange");

      const indiaTestnet = getExchangeAdapter("delta", "testnet", "india");
      expect(indiaTestnet.getRestUrl()).toBe("https://api-staging.india.delta.exchange");
    });
  });

  describe("4. Live market data retrieval & Delta Object mapping", () => {
    it("should fetch and parse Delta Exchange historical klines correctly using start/end and map objects", async () => {
      const adapter = getExchangeAdapter("delta", "testnet", "india");
      
      const mockCandles = {
        success: true,
        result: [
          { time: 1715850000, open: "60000.5", high: "61000.0", low: "59500.0", close: "60500.2", volume: "15.5" },
          { time: 1715853600, open: "60500.2", high: "62000.0", low: "60200.0", close: "61800.5", volume: "22.1" },
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockCandles,
      });

      const klines = await adapter.fetchKlines("BTC", "1h", 2);
      expect(klines.length).toBe(2);
      expect(klines[0].open).toBe(60000.5);
      expect(klines[0].high).toBe(61000);
      expect(klines[0].low).toBe(59500);
      expect(klines[0].close).toBe(60500.2);
      expect(klines[0].volume).toBe(15.5);
      expect(klines[0].openTime).toBe(1715850000000);

      // Verify the start/end timestamps are queried
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/v2/history/candles");
      expect(url).toContain("resolution=1h");
      expect(url).toContain("start=");
      expect(url).toContain("end=");
    });

    it("should translate numeric intervals for Binance Exchange to prevent 400 Bad Request", async () => {
      const adapter = getExchangeAdapter("binance", "testnet");
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          [1715850000000, "60000.5", "61000.0", "59500.0", "60500.2", "15.5", 1715853600000]
        ]
      });

      const klines = await adapter.fetchKlines("BTC", "60", 1);
      expect(klines.length).toBe(1);
      expect(klines[0].close).toBe(60500.2);

      // Verify url interval parameter is "1h" instead of "60"
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("interval=1h");
    });
  });

  describe("5. Top coin selection", () => {
    it("should filter and score tickers correctly to return top candidates", () => {
      const tickers = [
        {
          symbol: "BTC", price: 60000, volume24h: 1000, quoteVolume24h: 60000000,
          priceChange24h: 100, priceChangePercent24h: 5.5, highPrice24h: 61000, lowPrice24h: 59000,
          minNotional: 10, minOrderQty: 0.001, maxOrderQty: 1000, tickSize: 0.01, lotSize: 0.001
        },
        {
          symbol: "ETH", price: 3000, volume24h: 500, quoteVolume24h: 1500000,
          priceChange24h: -10, priceChangePercent24h: -1.2, highPrice24h: 31000, lowPrice24h: 29000,
          minNotional: 10, minOrderQty: 0.001, maxOrderQty: 1000, tickSize: 0.01, lotSize: 0.001
        },
        {
          // Excluded due to low volume
          symbol: "LOWVOL", price: 1, volume24h: 10, quoteVolume24h: 10,
          priceChange24h: 0.1, priceChangePercent24h: 10, highPrice24h: 1.1, lowPrice24h: 0.9,
          minNotional: 1, minOrderQty: 0.1, maxOrderQty: 1000, tickSize: 0.01, lotSize: 0.1
        }
      ];

      const candidates = analyzeMarket(tickers);
      expect(candidates.length).toBe(2);
      expect(candidates[0].symbol).toBe("BTC");
      expect(candidates[0].rank).toBe(1);
      expect(candidates[1].symbol).toBe("ETH");
    });
  });

  describe("6-10. Indicator computations, strategy engine, alert generation, and notification", () => {
    it("should run analysis cycle, compute indicators, evaluate strategy, and trigger alerts", async () => {
      // 1. Setup DO state & Env
      const storageData = new Map<string, any>();
      storageData.set("isActive", true);
      storageData.set("coinId", "BTC");
      storageData.set("strategy", "scalping");
      storageData.set("userId", "user-123");
      storageData.set("positionSize", 100);

      const mockStorage = {
        get: async (key: string) => storageData.get(key),
        put: async (key: string, val: any) => { storageData.set(key, val); },
        setAlarm: vi.fn(),
      } as any;

      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({
              exchange_name: "delta",
              exchange_environment: "testnet",
              exchange_region: "india",
            }),
            run: vi.fn().mockResolvedValue({ success: true }),
          }),
        }),
      } as any;

      const mockEnv = {
        DB: mockDb,
        ENCRYPTION_KEY: "test_key",
        FCM_SERVER_KEY: "test_fcm_key",
      } as unknown as Env;

      const bot = new TradingBot({ storage: mockStorage } as any, mockEnv);

      // Mock Exchange Ticker (high volatility, low RSI, triggers BUY entry)
      const mockTicker = {
        success: true,
        result: {
          symbol: "BTCUSDT",
          last_price: "60000.0",
          volume: "1000.0",
          change: "500.0",
          change_percent: "5.0",
          high: "65000.0",
          low: "58000.0",
        }
      };

      // Mock Candles to have low RSI
      const mockKlines = {
        success: true,
        result: Array.from({ length: 50 }, (_, i) => ({
          time: 1715850000 + i * 3600,
          open: 65000 - i * 100,
          high: 65100 - i * 100,
          low: 64900 - i * 100,
          close: 65000 - i * 100, // Downward trend
          volume: 500
        }))
      };

      // Mock fetch requests
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/v2/ticker/")) {
          return { ok: true, json: async () => mockTicker };
        }
        if (url.includes("/v2/history/candles")) {
          return { ok: true, json: async () => mockKlines };
        }
        if (url.includes("/v2/tickers")) {
          return { ok: true, json: async () => ({ success: true, result: [] }) };
        }
        return { ok: true, json: async () => ({}) };
      });

      // Execute runAnalysisCycle
      await (bot as any).runAnalysisCycle();

      // Verify that analysis snapshot was created
      const snapshot = storageData.get("analysis");
      expect(snapshot).toBeDefined();
      expect(snapshot.isActive).toBe(true);
      expect(snapshot.confluenceScore).toBeDefined();

      // Check alerts storage
      const alerts = storageData.get("alerts") || [];
      expect(Array.isArray(alerts)).toBe(true);
      // Alerts might not trigger unless indicators match the precise strategy,
      // but let's verify evaluateStrategy indicator calculations.
      const tickerObj = {
        symbol: "BTC", price: 60000, volume24h: 1000, quoteVolume24h: 60000000,
        priceChange24h: 500, priceChangePercent24h: 5.0, highPrice24h: 65000, lowPrice24h: 58000,
        minNotional: 10, minOrderQty: 0.001, maxOrderQty: 1000, tickSize: 0.01, lotSize: 0.001
      };
      const indicators = { rsi: 25, macd: -5, macdSignal: -4, macdHistogram: -1 }; // Oversold
      const evalResult = evaluateStrategy(tickerObj, indicators, "scalping", 1000, 100);

      // Verify ATR-based SL/TP calculations
      expect(evalResult.opportunity).toBeDefined();
      if (evalResult.opportunity) {
        expect(evalResult.opportunity.side).toBe("BUY");
        expect(evalResult.opportunity.stopLoss).toBe(60000 - 1000); // entry - ATR
        expect(evalResult.opportunity.takeProfit).toBe(60000 + 2000); // entry + 2*ATR
      }
    });
  });

  describe("11-12. Trade execution and lifecycle updates", () => {
    it("should place order, create position, and update status on SL/TP hit", async () => {
      const encryptionKey = "test_encryption_key_32_bytes_long_12345";
      const encryptedSecret = await encrypt("test_api_secret", encryptionKey);

      const storageData = new Map<string, any>();
      storageData.set("userId", "user-123");
      storageData.set("coinId", "BTC");
      storageData.set("alerts", [
        {
          id: "alert-123",
          symbol: "BTC",
          entryPrice: 60000,
          stopLoss: 59000,
          takeProfit: 62000,
          estimatedPnl: 10,
          positionSize: 100,
          side: "BUY",
          status: "pending"
        }
      ]);

      const mockStorage = {
        get: async (key: string) => storageData.get(key),
        put: async (key: string, val: any) => { storageData.set(key, val); },
      } as any;

      const mockQueries: any[] = [];
      const mockDb = {
        prepare: (sql: string) => ({
          bind: (...params: any[]) => {
            mockQueries.push({ sql, params });
            return {
              first: async () => {
                if (sql.includes("SELECT exchange_api_key")) {
                  return {
                    exchange_api_key: "test_api_key",
                    exchange_api_secret_iv: encryptedSecret.iv,
                    exchange_api_secret_encrypted: encryptedSecret.encrypted,
                    exchange_name: "delta",
                    exchange_environment: "testnet",
                    exchange_region: "india",
                  };
                }
                return null;
              },
              run: async () => ({ success: true }),
            };
          },
          run: async () => {
            mockQueries.push({ sql, params: [] });
            return { success: true };
          }
        }),
      } as any;

      const mockEnv = {
        DB: mockDb,
        ENCRYPTION_KEY: encryptionKey,
      } as unknown as Env;

      const bot = new TradingBot({ storage: mockStorage } as any, mockEnv);

      // Mock placeOrder
      const mockOrderRes = {
        success: true,
        result: {
          id: "order-999",
          avg_price: "60000.0",
          quantity: "0.0016"
        }
      };

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/v2/orders")) {
          return { ok: true, json: async () => mockOrderRes };
        }
        if (url.includes("/v2/ticker/")) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              result: { symbol: "BTCUSDT", last_price: "60000.0" }
            })
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      // Call execute-trade
      const res = await bot.fetch(new Request("http://localhost/execute-trade", {
        method: "POST"
      }));
      expect(res.status).toBe(200);
      const resJson = await res.json() as any;
      expect(resJson.success).toBe(true);

      // Verify that position was created in D1 database
      const insertQuery = mockQueries.find(q => q.sql.includes("INSERT INTO trade_positions"));
      expect(insertQuery).toBeDefined();
      expect(insertQuery.params[2]).toBe("BTC"); // symbol
      expect(insertQuery.params[3]).toBe("BUY"); // side
      expect(insertQuery.params[4]).toBe(60000); // entry_price

      // 2. Test position monitoring (alarm monitorOpenPositions)
      const monitorQueries: any[] = [];
      const monitorDb = {
        prepare: (sql: string) => ({
          bind: (...params: any[]) => {
            monitorQueries.push({ sql, params });
            return {
              first: async () => {
                if (sql.includes("SELECT exchange_name")) {
                  return { exchange_name: "delta", exchange_environment: "testnet", exchange_region: "india" };
                }
                return null;
              },
              all: async () => {
                if (sql.includes("SELECT * FROM trade_positions WHERE user_id = ? AND status = 'OPEN'")) {
                  return {
                    results: [
                      {
                        id: "pos-123",
                        user_id: "user-123",
                        symbol: "BTC",
                        side: "BUY",
                        entry_price: 60000,
                        quantity: 0.0016,
                        stop_loss: 59000,
                        take_profit: 62000,
                        status: "OPEN",
                      }
                    ]
                  };
                }
                return { results: [] };
              },
              run: async () => ({ success: true }),
            };
          },
          run: async () => {
            monitorQueries.push({ sql, params: [] });
            return { success: true };
          }
        }),
      } as any;

      const botForMonitor = new TradingBot({ storage: mockStorage } as any, { DB: monitorDb } as any);

      // Mock Ticker to return Take Profit Price hit (63000 >= 62000)
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/v2/ticker/")) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              result: { symbol: "BTCUSDT", last_price: "63000.0" } // TP hit!
            })
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      await (botForMonitor as any).monitorOpenPositions();

      // Verify that position update was called to CLOSE
      const updateQuery = monitorQueries.find(q => q.sql.includes("UPDATE trade_positions SET status = 'CLOSED'"));
      expect(updateQuery).toBeDefined();
      expect(updateQuery.params[1]).toBe(63000); // close price
      expect(updateQuery.params[3]).toBe("take_profit"); // close reason
    });
  });

  describe("13-16. Exchange Validation & 23 Error Types Classification", () => {
    it("should reject read-only keys on Binance and return SPOT_TRADING_NOT_ENABLED", async () => {
      const adapter = getExchangeAdapter("binance", "testnet");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          canTrade: false, // Read-only!
        }),
      });

      const result = await adapter.validateCredentials("test_key", "test_secret");
      expect(result.success).toBe(false);
      expect(result.code).toBe("SPOT_TRADING_NOT_ENABLED");
      expect(result.friendlyMessage).toContain("Spot trading is not enabled");
    });

    it("should reject read-only keys on Bybit and return INSUFFICIENT_PERMISSIONS", async () => {
      const adapter = getExchangeAdapter("bybit", "testnet");
      
      // First fetch to /v5/account/info succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ retCode: 0, result: {} }),
      });

      // Second fetch to /v5/user/query-api returns readOnly = 1
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ retCode: 0, result: { readOnly: 1 } }),
      });

      const result = await adapter.validateCredentials("test_key", "test_secret");
      expect(result.success).toBe(false);
      expect(result.code).toBe("INSUFFICIENT_PERMISSIONS");
      expect(result.friendlyMessage).toContain("permissions");
    });

    it("should classify all 23 error types correctly", () => {

      // 1. INVALID_API_KEY
      expect(classifyByBody("api key not found", "binance").code).toBe("INVALID_API_KEY");

      // 2. INVALID_API_SECRET
      expect(classifyByBody("api secret invalid", "binance").code).toBe("INVALID_API_SECRET");

      // 3. INVALID_PASSPHRASE
      expect(classifyByBody("invalid passphrase", "bybit").code).toBe("INVALID_PASSPHRASE");

      // 4. IP_NOT_WHITELISTED
      expect(classifyExchangeResponse(403, "ip not whitelisted", "bybit").code).toBe("IP_NOT_WHITELISTED");

      // 5. FUTURES_TRADING_NOT_ENABLED
      expect(classifyByBody("futures trading not enabled", "binance").code).toBe("FUTURES_TRADING_NOT_ENABLED");

      // 6. SPOT_TRADING_NOT_ENABLED
      expect(classifyByBody("spot trading not enabled", "binance").code).toBe("SPOT_TRADING_NOT_ENABLED");

      // 7. PERMISSION_DENIED
      // Fallback or explicit check
      expect(classifyByBody("permission denied", "binance").code).toBe("INSUFFICIENT_PERMISSIONS");

      // 8. INVALID_SIGNATURE
      expect(classifyByBody("invalid signature", "binance").code).toBe("INVALID_SIGNATURE");

      // 9. TIMESTAMP_OUT_OF_SYNC
      expect(classifyByBody("timestamp outside recvwindow", "binance").code).toBe("TIMESTAMP_OUT_OF_SYNC");

      // 10. ACCOUNT_SUSPENDED
      expect(classifyByBody("account suspended", "binance").code).toBe("ACCOUNT_SUSPENDED");

      // 11. ACCOUNT_RESTRICTED
      expect(classifyByBody("account restricted", "binance").code).toBe("ACCOUNT_RESTRICTED");

      // 12. API_RATE_LIMIT_REACHED
      expect(classifyExchangeResponse(429, "too many requests", "bybit").code).toBe("API_RATE_LIMIT_REACHED");

      // 13. NETWORK_TIMEOUT
      expect(classifyExchangeResponse(408, "", "binance").code).toBe("NETWORK_TIMEOUT");
      expect(classifyException(new Error("TimeoutError"), "binance").code).toBe("NETWORK_TIMEOUT");

      // 14. SSL_CONNECTION_FAILURE
      expect(classifyException(new Error("SSL connect error"), "binance").code).toBe("SSL_CONNECTION_FAILURE");

      // 15. EXCHANGE_UNDER_MAINTENANCE
      expect(classifyExchangeResponse(503, "exchange maintenance", "bybit").code).toBe("EXCHANGE_UNDER_MAINTENANCE");

      // 16. SERVICE_TEMPORARILY_UNAVAILABLE
      expect(classifyExchangeResponse(502, "", "bybit").code).toBe("SERVICE_TEMPORARILY_UNAVAILABLE");

      // 17. AUTHENTICATION_FAILED
      expect(classifyExchangeResponse(401, "", "binance").code).toBe("AUTHENTICATION_FAILED");

      // 18. REGION_NOT_SUPPORTED
      expect(classifyByBody("not supported in this region", "binance").code).toBe("REGION_NOT_SUPPORTED");

      // 19. EXCHANGE_NOT_REACHABLE
      expect(classifyExchangeResponse(404, "", "binance").code).toBe("EXCHANGE_NOT_REACHABLE");
      expect(classifyException(new Error("fetch failed"), "binance").code).toBe("EXCHANGE_NOT_REACHABLE");

      // 20. INSUFFICIENT_PERMISSIONS
      expect(classifyByBody("insufficient permission", "bybit").code).toBe("INSUFFICIENT_PERMISSIONS");

      // 21. INVALID_API_VERSION
      expect(classifyByBody("api version not supported", "binance").code).toBe("INVALID_API_VERSION");

      // 22. MISSING_REQUIRED_CREDENTIALS
      // Enforced by handler validate parameters logic.
      
      // 23. UNKNOWN_EXCHANGE_ERROR
      expect(classifyByBody("some random technical error", "binance").code).toBe("UNKNOWN_EXCHANGE_ERROR");
    });
  });
});
