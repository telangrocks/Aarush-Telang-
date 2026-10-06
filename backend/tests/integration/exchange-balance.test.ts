import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleGetExchangeBalances } from "../../src/handlers/exchange";
import { ExchangeManager } from "../../src/exchanges";
import * as cryptoModule from "../../src/crypto";
import { ExchangeErrorClassifier } from "../../src/exchanges/ExchangeErrorClassifier";
import { UnifiedError } from "../../src/exchanges";

describe("handleGetExchangeBalances - Read-Only Balance Auth Failure & Cache Eviction", () => {
  const userId = "test-user-id-422";
  const encryptionKey = "test-encryption-key-32-chars-long!";

  let mockDb: any;
  let mockEnv: any;
  let mockContext: any;
  let dbExecuteLog: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    dbExecuteLog = [];

    mockDb = {
      prepare: vi.fn((sql: string) => {
        dbExecuteLog.push(sql);
        return {
          bind: vi.fn((...params: any[]) => ({
            first: vi.fn(async () => {
              if (sql.includes("SELECT exchange_name")) {
                return {
                  exchange_name: "bybit",
                  exchange_environment: "demo",
                  exchange_region: "GLOBAL",
                  exchange_connection_status: "CONNECTED",
                  exchange_api_key_iv: "mock_iv",
                  exchange_api_key_encrypted: "mock_key_enc",
                  exchange_api_key_salt: "mock_salt",
                  exchange_api_secret_iv: "mock_iv",
                  exchange_api_secret_encrypted: "mock_sec_enc",
                  exchange_api_secret_salt: "mock_salt",
                  exchange_api_passphrase_iv: null,
                  exchange_api_passphrase_encrypted: null,
                  exchange_api_passphrase_salt: null,
                };
              }
              return null;
            }),
            run: vi.fn(async () => ({ success: true })),
          })),
        };
      }),
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: encryptionKey,
    };

    mockContext = {
      env: mockEnv,
      get: vi.fn((key: string) => {
        if (key === "jwtPayload") return { sub: userId };
        return null;
      }),
      status: vi.fn(),
      json: vi.fn((data: any) => new Response(JSON.stringify(data))),
    };

    // Mock decrypt to return sample strings
    vi.spyOn(cryptoModule, "decrypt").mockImplementation(async (data: any) => {
      if (data.encrypted === "mock_key_enc") return "decrypted_api_key";
      if (data.encrypted === "mock_sec_enc") return "decrypted_api_secret";
      return "decrypted_value";
    });
  });

  it("returns HTTP 422 with AUTHENTICATION_FAILED when Bybit returns 401, evicts cache, passes 'bybit' to classifier, and does NOT mutate D1 status to INVALID", async () => {
    // 1. Mock Bybit adapter fetchBalance to simulate Bybit HTTP 401 Unauthorized
    const mockAuthError = new UnifiedError(
      "Authentication failed with the exchange. Please check your API key, secret, and permissions.",
      "AUTHENTICATION_FAILED",
      401,
      "",
      401
    );

    const mockProvider = {
      fetchBalance: vi.fn().mockRejectedValue(mockAuthError),
    };

    vi.spyOn(ExchangeManager, "getProvider").mockResolvedValue(mockProvider as any);
    const invalidateSpy = vi.spyOn(ExchangeManager, "invalidateUserProvider").mockResolvedValue();
    const classifySpy = vi.spyOn(ExchangeErrorClassifier.getInstance(), "classifyException");

    // 2. Invoke handleGetExchangeBalances
    await handleGetExchangeBalances(mockContext);

    // 3. Assert classifier received 'bybit' as exchangeId (NOT 'exchange-balance')
    expect(classifySpy).toHaveBeenCalled();
    const [capturedError, capturedExchangeId] = classifySpy.mock.calls[0];
    expect(capturedExchangeId).toBe("bybit");

    // 4. Assert HTTP 422 status was set
    expect(mockContext.status).toHaveBeenCalledWith(422);

    // 5. Assert returned JSON contains AUTHENTICATION_FAILED
    expect(mockContext.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "AUTHENTICATION_FAILED",
      })
    );

    // 6. Assert in-memory provider cache eviction occurred
    expect(invalidateSpy).toHaveBeenCalledWith(
      "bybit",
      expect.objectContaining({
        apiKey: "decrypted_api_key",
        secret: "decrypted_api_secret",
      })
    );

    // 7. Assert D1 UPDATE users SET exchange_connection_status = 'INVALID' was NEVER executed
    const invalidationSqlExecuted = dbExecuteLog.some((sql) =>
      sql.includes("exchange_connection_status = 'INVALID'")
    );
    expect(invalidationSqlExecuted).toBe(false);
  });
});
