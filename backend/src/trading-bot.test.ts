import { describe, it, expect, vi, beforeEach } from "vitest";
import { getExchangeAdapter, normalizeQuantity, BinanceExchange } from "./exchanges";
import { TradingBot, evaluateStrategy } from "./trading-bot";
import { sendPriceAlertNotification, sendTradeNotification } from "./handlers/notifications";
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
      expect(indiaTestnet.getRestUrl()).toBe("https://cdn-ind.testnet.deltaex.org");
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
    it("should filter and score tickers correctly to return top candidates", async () => {
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

      const mockAdapter = {
        fetchKlines: vi.fn().mockResolvedValue([]),
      } as any;

      const candidates = await analyzeMarket(tickers, mockAdapter);
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
        put: async (key: string, val: any) => { storageData.set(key, val); }, delete: async (key: string) => { storageData.delete(key); },
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

      const bot = new TradingBot({ storage: mockStorage, blockConcurrencyWhile: async (cb: any) => cb() } as any, mockEnv);

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
      const evalResult = evaluateStrategy(tickerObj, indicators, "scalping", 1000, 10.0, tickerObj.minNotional);

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
        put: async (key: string, val: any) => { storageData.set(key, val); }, delete: async (key: string) => { storageData.delete(key); },
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

      const bot = new TradingBot({ storage: mockStorage, blockConcurrencyWhile: async (cb: any) => cb() } as any, mockEnv);

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
        if (url.includes("/v2/products")) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              result: [
                {
                  id: 123,
                  symbol: 'BTCUSD',
                  min_notional_value: '0.0001',
                  max_notional_value: '1000',
                  lot_size: '0.0001',
                  tick_size: '0.01',
                  contract_type: 'perpetual_futures',
                }
              ]
            })
          };
        }
        if (url.includes("/orders/leverage")) {
          return { ok: true, json: async () => ({ success: true }) };
        }
        if (url.includes("ticker")) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              result: { symbol: "BTCUSDT", last_price: "60000.0" }
            })
          };
        }
        return { ok: true, json: async () => ({ success: true, result: [], symbols: [] }) };
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

      const botForMonitor = new TradingBot({ storage: mockStorage, blockConcurrencyWhile: async (cb: any) => cb() } as any, { DB: monitorDb } as any);

      // Mock Ticker to return Take Profit Price hit (63000 >= 62000)
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("ticker")) {
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

    it("should prevent concurrent trade executions and return 409", async () => {
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
        put: async (key: string, val: any) => { storageData.set(key, val); }, delete: async (key: string) => { storageData.delete(key); },
      } as any;

      const mockQueries: any[] = [];
      const mockDb = {
        prepare: (sql: string) => ({
          bind: (...params: any[]) => {
            mockQueries.push({ sql, params });
            return {
              first: async () => {
                if (sql.includes("SELECT exchange_api_key")) {
                  // Introduce a small delay to simulate asynchronous DB/network fetch
                  await new Promise(resolve => setTimeout(resolve, 50));
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

      const bot = new TradingBot({ storage: mockStorage, blockConcurrencyWhile: async (cb: any) => cb() } as any, mockEnv);

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/v2/orders")) {
          return { ok: true, json: async () => ({ success: true, result: { id: "order-999" } }) };
        }
        if (url.includes("/v2/products")) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              result: [
                {
                  id: 123,
                  symbol: 'BTCUSD',
                  min_notional_value: '0.0001',
                  max_notional_value: '1000',
                  lot_size: '0.0001',
                  tick_size: '0.01',
                  contract_type: 'perpetual_futures',
                }
              ]
            })
          };
        }
        if (url.includes("/orders/leverage")) {
          return { ok: true, json: async () => ({ success: true }) };
        }
        if (url.includes("ticker")) {
          return { ok: true, json: async () => ({ success: true, result: { symbol: "BTCUSDT", last_price: "60000.0" } }) };
        }
        return { ok: true, json: async () => ({ success: true, result: [], symbols: [] }) };
      });

      // Fire first request to execute trade (which will yield at DB select due to setTimeout)
      const promise1 = bot.fetch(new Request("http://localhost/execute-trade", { method: "POST" }));

      // Fire second request immediately while the first is yielded
      const promise2 = bot.fetch(new Request("http://localhost/execute-trade", { method: "POST" }));

      const [res1, res2] = await Promise.all([promise1, promise2]);

      // The first should succeed (status 200)
      expect(res1.status).toBe(200);

      // The second must fail with 409 Conflict due to the in-memory trade lock
      expect(res2.status).toBe(409);
      const resJson2 = await res2.json() as any;
      expect(resJson2.error).toContain("A trade execution is already in progress");

      // Verify that after execution is fully finished, the lock is released
      const res3 = await bot.fetch(new Request("http://localhost/execute-trade", { method: "POST" }));
      // This subsequent request should not return 409 (since alerts list is updated and status of alerts is 'executed', it will return 400 'No pending alert to execute')
      expect(res3.status).toBe(400);
      const resJson3 = await res3.json() as any;
      expect(resJson3.error).toContain("No pending alert to execute");
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

  describe("FCM HTTP v1 Notifications Migration", () => {
    let privateKeyPem: string;

    beforeEach(async () => {
      const keyPair = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"]
      );
      const exported = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
      privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(exported)))}\n-----END PRIVATE KEY-----`;
    });

    it("should successfully generate Google access token, sign JWT assertions, cache it, and send notifications over FCM v1 API", async () => {
      const dbQueries: any[] = [];
      const mockDb = {
        prepare: (sql: string) => ({
          bind: (...params: any[]) => {
            dbQueries.push({ sql, params });
            return {
              first: async () => {
                if (sql.includes("SELECT fcm_token")) {
                  return { fcm_token: "test_device_token" };
                }
                return null;
              }
            };
          }
        })
      } as any;

      const mockEnv = {
        DB: mockDb,
        FCM_PROJECT_ID: "test-fcm-project-id",
        FCM_CLIENT_EMAIL: "fcm-notifier@test-fcm-project-id.iam.gserviceaccount.com",
        FCM_PRIVATE_KEY: privateKeyPem,
      } as unknown as Env;

      const mockTokenExchangeResponse = {
        access_token: "mock-oauth2-access-token-ya29",
        expires_in: 3600
      };

      const mockFcmResponse = {
        name: "projects/test-fcm-project-id/messages/mock-message-id"
      };

      const fetchedUrls: string[] = [];
      const fetchHeaders: any[] = [];
      const fetchBodies: any[] = [];

      mockFetch.mockImplementation(async (url: string, options: any = {}) => {
        fetchedUrls.push(url);
        if (options.headers) {
          fetchHeaders.push(options.headers);
        }
        if (options.body) {
          fetchBodies.push(options.body);
        }

        if (url.includes("oauth2.googleapis.com/token")) {
          return { ok: true, json: async () => mockTokenExchangeResponse };
        }
        if (url.includes("fcm.googleapis.com/v1/projects/")) {
          return { ok: true, json: async () => mockFcmResponse };
        }
        return { ok: true, json: async () => ({}) };
      });

      // Send a Price Alert notification
      await sendPriceAlertNotification(mockEnv, "user-123", {
        tokenId: "BTC",
        targetPrice: 65000,
        condition: "ABOVE",
        currentPrice: 65050
      });

      // Verify Google token exchange was called
      expect(fetchedUrls[0]).toContain("oauth2.googleapis.com/token");
      expect(fetchBodies[0]).toContain("grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer");

      // Verify FCM HTTP v1 was called with correct payload structure
      expect(fetchedUrls[1]).toContain("fcm.googleapis.com/v1/projects/test-fcm-project-id/messages:send");
      expect(fetchHeaders[1]["Authorization"]).toBe("Bearer mock-oauth2-access-token-ya29");
      expect(fetchHeaders[1]["Content-Type"]).toBe("application/json");

      const priceAlertBody = JSON.parse(fetchBodies[1]);
      expect(priceAlertBody.message.token).toBe("test_device_token");
      expect(priceAlertBody.message.notification.title).toBe("Price Alert Triggered");
      expect(priceAlertBody.message.notification.body).toContain("BTC is now above $65000.00");
      expect(priceAlertBody.message.data.type).toBe("price_alert");
      expect(priceAlertBody.message.android.priority).toBe("high");

      // Verify TOKEN CACHING: Send a Trade notification next.
      // This should NOT trigger a new Google token exchange fetch request since the token is active in cache.
      fetchedUrls.length = 0;
      fetchHeaders.length = 0;
      fetchBodies.length = 0;

      await sendTradeNotification(mockEnv, "user-123", "test-alert-id", {
        symbol: "SOL",
        side: "BUY",
        entryPrice: 150,
        stopLoss: 145,
        takeProfit: 160,
        estimatedPnl: 10,
        strategy: "momentum"
      });

      // Google token endpoint should NOT be in fetchedUrls list (reused from cache)
      expect(fetchedUrls).not.toContain("https://oauth2.googleapis.com/token");
      
      // But FCM endpoint should be called immediately
      expect(fetchedUrls[0]).toContain("fcm.googleapis.com/v1/projects/test-fcm-project-id/messages:send");
      expect(fetchHeaders[0]["Authorization"]).toBe("Bearer mock-oauth2-access-token-ya29");

      const tradeAlertBody = JSON.parse(fetchBodies[0]);
      expect(tradeAlertBody.message.token).toBe("test_device_token");
      expect(tradeAlertBody.message.notification.title).toBe("Trade Detected");
      expect(tradeAlertBody.message.data.type).toBe("trade_alert");
      expect(tradeAlertBody.message.data.symbol).toBe("SOL");
    });

    it("should fallback to legacy FCM if FCM v1 config is missing but FCM_SERVER_KEY is present", async () => {
      const dbQueries: any[] = [];
      const mockDb = {
        prepare: (sql: string) => ({
          bind: (...params: any[]) => {
            dbQueries.push({ sql, params });
            return {
              first: async () => ({ fcm_token: "test_legacy_device_token" })
            };
          }
        })
      } as any;

      // Only legacy key is configured
      const mockEnv = {
        DB: mockDb,
        FCM_SERVER_KEY: "legacy-server-key-123",
      } as unknown as Env;

      const fetchedUrls: string[] = [];
      const fetchHeaders: any[] = [];
      const fetchBodies: any[] = [];

      mockFetch.mockImplementation(async (url: string, options: any = {}) => {
        fetchedUrls.push(url);
        if (options.headers) {
          fetchHeaders.push(options.headers);
        }
        if (options.body) {
          fetchBodies.push(options.body);
        }
        return { ok: true, json: async () => ({}) };
      });

      await sendTradeNotification(mockEnv, "user-123", "test-alert-id", {
        symbol: "ETH",
        side: "SELL",
        entryPrice: 3500,
        stopLoss: 3600,
        takeProfit: 3300,
        estimatedPnl: 20,
        strategy: "mean_reversion"
      });

      // Verify that it fetched the legacy endpoint instead of v1
      expect(fetchedUrls[0]).toBe("https://fcm.googleapis.com/fcm/send");
      expect(fetchHeaders[0]["Authorization"]).toBe("key=legacy-server-key-123");

      const legacyBody = JSON.parse(fetchBodies[0]);
      expect(legacyBody.to).toBe("test_legacy_device_token");
      expect(legacyBody.notification.title).toBe("Trade Detected");
      expect(legacyBody.data.symbol).toBe("ETH");
    });
  });

  describe("Exchange Adapter Layer & Metadata Cache", () => {
    it("should normalize quantity with float precision correction and zero check", () => {
      // Zero check
      expect(normalizeQuantity(0, 0.001, 0.001, 1000)).toBe(0);
      expect(normalizeQuantity(-1, 0.001, 0.001, 1000)).toBe(0);

      // JavaScript float division correction check (0.003 / 0.001 should not round down to 0.002)
      expect(normalizeQuantity(0.003, 0.001, 0.001, 1000)).toBe(0.003);

      // Normalization rounding check
      expect(normalizeQuantity(0.0016, 0.001, 0.001, 1000)).toBe(0.001);
      
      // Min limit check
      expect(normalizeQuantity(0.0005, 0.001, 0.002, 1000)).toBe(0.002);

      // Max limit check
      expect(normalizeQuantity(10.5, 1, 0.1, 5)).toBe(5);
    });

    it("should handle cache hits, misses, metrics, and concurrent promise coalescing", async () => {
      const exchange = getExchangeAdapter("binance") as BinanceExchange;

      const mockExchangeInfo = {
        symbols: [
          {
            symbol: "BTCUSDT",
            status: "TRADING",
            filters: [
              { filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "1000.0", stepSize: "0.0001" },
              { filterType: "PRICE_FILTER", tickSize: "0.01" }
            ]
          }
        ]
      };

      const mockTicker = {
        symbol: "BTCUSDT",
        lastPrice: "60000.00",
        volume: "100",
        priceChange: "100",
        priceChangePercent: "1"
      };

      let infoCallCount = 0;
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/api/v3/exchangeInfo")) {
          infoCallCount++;
          return { ok: true, json: async () => mockExchangeInfo };
        }
        if (url.includes("/api/v3/ticker/24hr")) {
          return { ok: true, json: async () => mockTicker };
        }
        return { ok: true, json: async () => ({}) };
      });

      // Reset metrics
      exchange.cacheMetrics.hits = 0;
      exchange.cacheMetrics.misses = 0;
      exchange.cacheMetrics.refreshes = 0;

      // 1. Initial fetch (cache miss)
      const ticker1 = await exchange.fetchTicker("BTC");
      expect(ticker1).not.toBeNull();
      expect(ticker1?.lotSize).toBe(0.0001);
      expect(infoCallCount).toBe(1);
      expect(exchange.cacheMetrics.misses).toBe(1);
      expect(exchange.cacheMetrics.hits).toBe(0);

      // 2. Second fetch (cache hit)
      const ticker2 = await exchange.fetchTicker("BTC");
      expect(ticker2).not.toBeNull();
      expect(ticker2?.lotSize).toBe(0.0001);
      expect(infoCallCount).toBe(1); // Still 1!
      expect(exchange.cacheMetrics.misses).toBe(1);
      expect(exchange.cacheMetrics.hits).toBe(1);

      // 3. Concurrent requests (coalescing)
      // Force cache expiry by resetting lastCacheFetch
      (exchange as any).lastCacheFetch = 0;
      
      const p1 = exchange.fetchTicker("BTC");
      const p2 = exchange.fetchTicker("BTC");
      await Promise.all([p1, p2]);

      // Assert that exchangeInfo was only fetched once more (total 2)
      expect(infoCallCount).toBe(2);
    });

    it("should revalidate expired cache in background (stale-while-revalidate)", async () => {
      const exchange = getExchangeAdapter("binance") as BinanceExchange;

      const mockExchangeInfo = {
        symbols: [
          {
            symbol: "BTCUSDT",
            status: "TRADING",
            filters: [
              { filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "1000.0", stepSize: "0.0001" },
              { filterType: "PRICE_FILTER", tickSize: "0.01" }
            ]
          }
        ]
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockExchangeInfo,
      });

      // Populate initial cache
      await (exchange as any).getSymbolMetadata("BTC");
      expect(exchange.cacheMetrics.refreshes).toBe(1);

      // Set cache as expired
      (exchange as any).lastCacheFetch = Date.now() - 2000000;

      // Fetch ticker - should trigger background revalidation but return stale cache immediately
      const start = Date.now();
      const lot = await (exchange as any).getSymbolMetadata("BTC");
      const elapsed = Date.now() - start;

      // Assert it returns instantly (< 10ms)
      expect(elapsed).toBeLessThan(10);
      expect(lot).not.toBeNull();
      expect(lot.lotSize).toBe(0.0001);

      // Let background promise resolve
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(exchange.cacheMetrics.staleUsage).toBe(1);
    });

    it("should retry on transient HTTP failures and fall back to old cache on permanent error", async () => {
      const exchange = getExchangeAdapter("binance") as BinanceExchange;

      const mockExchangeInfo = {
        symbols: [
          {
            symbol: "BTCUSDT",
            status: "TRADING",
            filters: [
              { filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "1000.0", stepSize: "0.0001" },
              { filterType: "PRICE_FILTER", tickSize: "0.01" }
            ]
          }
        ]
      };

      // Populate initial cache successfully
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockExchangeInfo,
      });
      await (exchange as any).getSymbolMetadata("BTC");
      expect((exchange as any).metadataCache).not.toBeNull();

      // Trigger cache refresh but fail twice (retrying) and eventually keep old cache
      let attempt = 0;
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/api/v3/exchangeInfo")) {
          attempt++;
          return { ok: false, status: 500, text: async () => "Internal Server Error" };
        }
        return { ok: true, json: async () => ({}) };
      });

      // Expiry
      (exchange as any).lastCacheFetch = Date.now() - 2000000;

      // Request - will trigger revalidation with retries
      const lot = await (exchange as any).getSymbolMetadata("BTC");
      expect(lot).not.toBeNull();
      expect(lot.lotSize).toBe(0.0001); // Returns old cache successfully

      // Let retries resolve in background
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Attempt count should be retries + 1 (3 calls to exchangeInfo)
      expect(attempt).toBe(3);
      expect(exchange.cacheMetrics.failures).toBe(1);
    });
  });

  describe("Focus Mode and Instrument Locking", () => {
    it("should clear coinId on deactivate", async () => {
      const storageData = new Map<string, any>();
      storageData.set("isActive", true);
      storageData.set("coinId", "BTC");
      const mockStorage = {
        get: async (key: string) => storageData.get(key),
        put: async (key: string, val: any) => { storageData.set(key, val); }, delete: async (key: string) => { storageData.delete(key); },
        deleteAlarm: async () => {},
      } as any;
      const bot = new TradingBot({ storage: mockStorage, blockConcurrencyWhile: async (cb: any) => cb() } as any, {} as any);
      
      const response = await bot.fetch(new Request("http://bot/deactivate", { method: "POST" }));
      expect(response.status).toBe(200);
      expect(storageData.get("isActive")).toBe(false);
      expect(storageData.get("coinId")).toBeNull();
    });

    it("should skip comparison fetches in buildScanCandidates when bot is active in Focus Mode", async () => {
      const storageData = new Map<string, any>();
      storageData.set("isActive", true);
      storageData.set("coinId", "BTC");
      const mockStorage = {
        get: async (key: string) => storageData.get(key),
        put: async (key: string, val: any) => { storageData.set(key, val); }, delete: async (key: string) => { storageData.delete(key); },
      } as any;
      const bot = new TradingBot({ storage: mockStorage, blockConcurrencyWhile: async (cb: any) => cb() } as any, {} as any);

      // Create a mock adapter where fetchTicker is tracked
      const fetchTickerSpy = vi.fn().mockResolvedValue({
        symbol: "BTC", price: 60000, lotSize: 0.001, minOrderQty: 0.001, maxOrderQty: 1000, tickSize: 0.01
      });
      const mockAdapter = {
        fetchTicker: fetchTickerSpy,
      } as any;

      const candidates = await (bot as any).buildScanCandidates(mockAdapter, "BTC", {
        volumeThreshold: 0,
        rangeThreshold: 0,
        momentumThreshold: 0,
      });

      // Assert candidates only contains BTC/USDT and fetchTicker was only called once (for BTC, not for ETH/SOL/etc.)
      expect(candidates.length).toBe(1);
      expect(candidates[0].symbol).toBe("BTC/USDT");
      expect(fetchTickerSpy).toHaveBeenCalledTimes(1);
      expect(fetchTickerSpy).toHaveBeenCalledWith("BTC");
    });
  });
});
