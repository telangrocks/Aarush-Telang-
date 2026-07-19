import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "./index";
import { Env } from "./index";
import { sign } from "hono/jwt";
import { hashPassword } from "./handlers/auth";

declare const global: typeof globalThis;

vi.mock("./exchanges", () => ({
  getExchangeAdapter: () => ({
    validateCredentials: vi.fn().mockResolvedValue({ success: true, message: "OK" }),
    fetchMarketData: vi.fn().mockResolvedValue([]),
    fetchTicker: vi.fn().mockResolvedValue(null),
  }),
  ExchangeName: "binance",
  SUPPORTED_EXCHANGES: [],
}));

function createStatementForQuery(query: string) {
  if (query === "SELECT id, status FROM users WHERE email = ?") {
    return {
      bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
    };
  }

  if (query.includes("INSERT INTO users")) {
    return {
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    };
  }

  if (query.includes("UPDATE users SET password_hash")) {
    return {
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    };
  }

  if (
    query ===
    "SELECT id, email, password_hash, status, failed_login_attempts, locked_until FROM users WHERE email = ?"
  ) {
    return {
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue({
          id: "existing-user-id",
          email: "login@example.com",
          password_hash: "invalid:test-hash",
          status: "PENDING_VERIFICATION",
          failed_login_attempts: 0,
          locked_until: null,
        }),
      })),
    };
  }

  if (query === "SELECT count, window_start FROM registration_attempts WHERE ip = ?") {
    return {
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(null),
      })),
    };
  }

  if (query.includes("INSERT INTO registration_attempts")) {
    return {
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    };
  }

  if (query.includes("INSERT INTO refresh_tokens")) {
    return {
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    };
  }

  if (query.includes("UPDATE registration_attempts SET count")) {
    return {
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    };
  }

  if (query.includes("UPDATE users SET status = 'ACTIVE'")) {
    return {
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    };
  }

  if (query.includes("UPDATE users SET failed_login_attempts")) {
    return {
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    };
  }

  if (query.includes("UPDATE users SET exchange_name")) {
    return {
      bind: vi.fn(() => ({
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    };
  }

  return null;
}

function makeSimpleDb(): D1Database {
  const statement = {
    bind: vi.fn(() => ({
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true }),
    })),
  };
  return {
    prepare: vi.fn(() => statement),
    batch: vi.fn(() => Promise.resolve([])),
  } as unknown as D1Database;
}

function baseEnv(extra: Partial<Env> = {}): Env {
  return {
    DB: { prepare: vi.fn(), batch: vi.fn(() => Promise.resolve([])) } as unknown as D1Database,
    ENCRYPTION_KEY: "test-encryption-key-12345678901234567890123456789012-12345678901234567890123456789012",
    JWT_SECRET: "test-jwt-secret-12345678901234567890123456789012",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_EMAIL: "test@example.com",
    ALLOWED_ORIGINS: "https://example.com",
    ...extra,
  } as unknown as Env;
}

describe("App Endpoints", () => {
  it("GET /health returns status ok", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/health"),
      baseEnv(),
    );
    expect(res.status).toBe(200);
    const data = await res.json<{
      status: string;
      service: string;
      timestamp: string;
    }>();
    expect(data.status).toBe("ok");
    expect(data.service).toBe("Crypto Pulse Backend");
    expect(data.timestamp).toBeDefined();
  });

  it("GET /db-status returns ok when DB is available", async () => {
    const mockPrepare = vi.fn((query: string) => {
      if (query === "SELECT 1") {
        return {
          run: vi.fn().mockResolvedValue({}),
        };
      }

      if (
        query ===
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      ) {
        return {
          bind: vi.fn((tableName: string) => ({
            first: vi.fn().mockResolvedValue({ name: tableName }),
          })),
        };
      }

      throw new Error(`Unexpected query: ${query}`);
    });

    const mockEnv = {
      ...baseEnv(),
      DB: {
        prepare: mockPrepare,
      } as unknown as D1Database,
    };

    const res = await worker.fetch(
      new Request("http://localhost/db-status"),
      mockEnv as Env,
    );
    expect(res.status).toBe(200);
    const data = await res.json<{
      status: string;
      message: string;
      tablesChecked: string[];
    }>();
    expect(data.status).toBe("ok");
    expect(data.message).toBe("Database connection successful");
    expect(data.tablesChecked).toEqual([
      "users",
      "watchlist",
      "portfolio_transactions",
      "price_alerts",
      "jwt_blacklist",
      "refresh_tokens",
      "login_attempts",
      "password_reset_tokens",
      "audit_log",
    ]);
  });

  it("GET /db-status returns error when DB fails", async () => {
    // Mock the environment
    const mockEnv = {
      ...baseEnv(),
      DB: {
        prepare: vi.fn().mockReturnValue({
          run: vi.fn().mockRejectedValue(new Error("Connection timeout")),
        }),
      } as unknown as D1Database,
    };

    const res = await worker.fetch(
      new Request("http://localhost/db-status"),
      mockEnv as Env,
    );
    expect(res.status).toBe(500);
    const data = await res.json<{ status: string; message: string }>();
    expect(data.status).toBe("error");
    expect(data.message).toBe("Database connection failed");
  });

  it("POST /api/register creates an active account and returns tokens", async () => {
    const mockEnv = {
      DB: {
        prepare: vi.fn((query: string) => {
          const statement = createStatementForQuery(query);
          if (!statement) {
            throw new Error(`Unexpected query: ${query}`);
          }
          return statement;
        }),
      } as unknown as D1Database,
      ENCRYPTION_KEY: "test-encryption-key-12345678901234567890123456789012",
      JWT_SECRET: "test-jwt-secret-12345678901234567890123456789012",
      RESEND_API_KEY: "test-resend-key",
      RESEND_FROM_EMAIL: "test@example.com",
      PRICE_CACHE: {} as KVNamespace,
      TRADING_BOTS: {} as DurableObjectNamespace,
      ALLOWED_ORIGINS: "https://example.com",
    };

    const res = await worker.fetch(
      new Request("http://localhost/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "New@Example.com",
          password: "TestPass123!",
          confirmPassword: "TestPass123!",
        }),
      }),
      mockEnv as Env,
    );

    expect(res.status).toBe(201);
    const data = await res.json<{
      message: string;
      accessToken?: string;
      refreshToken?: string;
    }>();
    expect(data.message).toBe("Account created successfully.");
    expect(data.accessToken).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
  });

  it("POST /api/register rejects weak passwords", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "weak@example.com",
          password: "password",
          confirmPassword: "password",
        }),
      }),
      {
        DB: makeSimpleDb(),
        ENCRYPTION_KEY: "test-encryption-key-12345678901234567890123456789012",
        JWT_SECRET: "test-jwt-secret-12345678901234567890123456789012",
        RESEND_API_KEY: "test-resend-key",
        TRADING_BOTS: {} as DurableObjectNamespace,
        ALLOWED_ORIGINS: "https://example.com",
      } as Env,
    );
    expect(res.status).toBe(400);
  });

  it("POST /api/register rejects mismatched passwords", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "mismatch@example.com",
          password: "TestPass123!",
          confirmPassword: "Different123!",
        }),
      }),
      {
        DB: makeSimpleDb(),
        ENCRYPTION_KEY: "test-encryption-key-12345678901234567890123456789012",
        JWT_SECRET: "test-jwt-secret-12345678901234567890123456789012",
        RESEND_API_KEY: "test-resend-key",
        TRADING_BOTS: {} as DurableObjectNamespace,
        ALLOWED_ORIGINS: "https://example.com",
      } as Env,
    );
    expect(res.status).toBe(400);
  });

  it("POST /api/register rejects non-JSON content type with 415", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/register", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "email=foo",
      }),
      { ALLOWED_ORIGINS: "https://example.com" } as Env,
    );
    expect(res.status).toBe(415);
  });

  it("POST /api/register returns 429 when rate limit is exceeded", async () => {
    const mockEnv = {
      DB: {
        prepare: vi.fn((query: string) => {
          if (query === "SELECT count, window_start FROM registration_attempts WHERE ip = ?") {
            return {
              bind: vi.fn(() => ({
                first: vi.fn().mockResolvedValue({
                  count: 10,
                  window_start: Date.now(),
                }),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ success: true }) })),
          };
        }),
      } as unknown as D1Database,
      ENCRYPTION_KEY: "test-encryption-key-12345678901234567890123456789012",
      JWT_SECRET: "test-jwt-secret-12345678901234567890123456789012",
      RESEND_API_KEY: "test-resend-key",
      TRADING_BOTS: {} as DurableObjectNamespace,
      ALLOWED_ORIGINS: "https://example.com",
    };

    const res = await worker.fetch(
      new Request("http://localhost/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "limited@example.com",
          password: "TestPass123!",
          confirmPassword: "TestPass123!",
        }),
      }),
      mockEnv as Env,
    );
    expect(res.status).toBe(429);
  });

  describe("Protected API Endpoints", () => {
    let mockEnv: Partial<Env>;
    let token: string;
    const userId = "user-123";
    const testJti = "test-jti-123";

    beforeEach(async () => {
      const all = vi
        .fn()
        .mockResolvedValue({ results: [{ id: "btc", user_id: userId }] });
      const run = vi.fn().mockResolvedValue({ success: true });
      const bind = vi.fn(() => ({ all, run }));

      mockEnv = {
        DB: {
          prepare: vi.fn((query: string) => {
            if (query.includes("SELECT jti FROM jwt_blacklist WHERE jti = ?")) {
              return {
                bind: vi.fn(() => ({
                  first: vi.fn().mockResolvedValue(null),
                })),
              };
            }
            const stmt = { bind };
            return stmt;
          }),
        } as unknown as D1Database,
        ENCRYPTION_KEY: "test-encryption-key-12345678901234567890123456789012",
        JWT_SECRET: "test-jwt-secret-12345678901234567890123456789012",
        RESEND_API_KEY: "test-resend-key",
        TRADING_BOTS: {} as DurableObjectNamespace,
        ALLOWED_ORIGINS: "https://example.com",
      };
      token = await sign(
        { sub: userId, email: "test@test.com", jti: testJti },
        mockEnv.JWT_SECRET!,
      );
    });

    it("GET /api/watchlist should return watchlist for authenticated user", async () => {
      const req = new Request("http://localhost/api/watchlist", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const res = await worker.fetch(req, mockEnv as Env);
      expect(res.status).toBe(200);
      const data = await res.json<{ user_id: string }[]>();
      expect(data[0].user_id).toBe(userId);
      expect(mockEnv.DB?.prepare).toHaveBeenCalledWith(
        "SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC",
      );
      expect(mockEnv.DB?.prepare("stmt").bind).toHaveBeenCalledWith(userId);
    });

    it("POST /api/watchlist should add item for authenticated user", async () => {
      const body = { token_id: "ethereum" };
      const req = new Request("http://localhost/api/watchlist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const res = await worker.fetch(req, mockEnv as Env);
      expect(res.status).toBe(200);
      const data = await res.json<{ success: boolean; token_id: string }>();
      expect(data.success).toBe(true);
      expect(data.token_id).toBe("ethereum");
      expect(mockEnv.DB?.prepare).toHaveBeenCalledWith(
        "INSERT INTO watchlist (id, user_id, token_id, added_at) VALUES (?, ?, ?, ?)",
      );
      expect(mockEnv.DB?.prepare("stmt").bind).toHaveBeenCalledWith(
        expect.any(String),
        userId,
        "ethereum",
        expect.any(String),
      );
    });

    it("DELETE /api/watchlist/:id should remove item for authenticated user", async () => {
      const itemId = "item-to-delete";
      const req = new Request(`http://localhost/api/watchlist/${itemId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      const res = await worker.fetch(req, mockEnv as Env);
      expect(res.status).toBe(200);
      const data = await res.json<{ success: boolean }>();
      expect(data.success).toBe(true);
      expect(mockEnv.DB?.prepare).toHaveBeenCalledWith(
        "DELETE FROM watchlist WHERE id = ? AND user_id = ?",
      );
      expect(mockEnv.DB?.prepare("stmt").bind).toHaveBeenCalledWith(
        itemId,
        userId,
      );
    });

    it("should return 401 for protected routes without a valid token", async () => {
      const req = new Request("http://localhost/api/watchlist");
      const res = await worker.fetch(req, mockEnv as Env);
      expect(res.status).toBe(401);
    });

    it("POST /api/alerts should create a new price alert", async () => {
      const body = {
        token_id: "bitcoin",
        target_price: 70000,
        condition: "ABOVE",
      };
      const req = new Request("http://localhost/api/alerts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const res = await worker.fetch(req, mockEnv as Env);
      expect(res.status).toBe(200);
      const data = await res.json<{ success: boolean; token_id: string }>();
      expect(data.success).toBe(true);
      expect(data.token_id).toBe("bitcoin");
      expect(mockEnv.DB?.prepare).toHaveBeenCalledWith(
        "INSERT INTO price_alerts (id, user_id, token_id, target_price, condition, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
    });

    it("POST /api/exchange/connect should store encrypted keys", async () => {
      const body = { exchangeName: "binance", apiKey: "test-api-key", apiSecret: "test-api-secret", environment: "testnet" };
      const req = new Request("http://localhost/api/exchange/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const res = await worker.fetch(req, mockEnv as Env);
      expect(res.status).toBe(200);
      const data = await res.json<{ success: boolean }>();
      expect(data.success).toBe(true);
      expect(mockEnv.DB?.prepare).toHaveBeenCalledWith(
        "UPDATE users SET exchange_name = ?, exchange_environment = ?, exchange_region = ?, exchange_api_key = ?, exchange_api_secret_iv = ?, exchange_api_secret_encrypted = ? WHERE id = ?",
      );
      expect(mockEnv.DB?.prepare("stmt").bind).toHaveBeenCalledWith(
        "binance",
        "testnet",
        "india",
        "test-api-key",
        expect.any(String),
        expect.any(String),
        userId,
      );
    });

    it("POST /api/logout should blacklist the current JWT and clear FCM token", async () => {
      const mockLogoutDb = {
        prepare: vi.fn((query: string) => {
          if (query.includes("SELECT jti FROM jwt_blacklist WHERE jti = ?")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn().mockResolvedValue(null),
              })),
            };
          }
          if (query.includes("INSERT OR IGNORE INTO jwt_blacklist")) {
            return {
              bind: vi.fn(() => ({
                run: vi.fn().mockResolvedValue({ success: true }),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ success: true }) })),
          };
        }),
      } as unknown as D1Database;

      const logoutEnv = {
        ...mockEnv,
        DB: mockLogoutDb,
      };

      const req = new Request("http://localhost/api/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const res = await worker.fetch(req, logoutEnv as Env);
      expect(res.status).toBe(200);
      const data = await res.json<{ success: boolean; message: string }>();
      expect(data.success).toBe(true);
      expect(mockLogoutDb.prepare).toHaveBeenCalledWith(
        "UPDATE users SET fcm_token = NULL WHERE id = ?",
      );
    });

    it("blacklisted JWT should be rejected by protected routes", async () => {
      const mockBlacklistDb = {
        prepare: vi.fn((query: string) => {
          if (query.includes("SELECT jti FROM jwt_blacklist WHERE jti = ?")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn().mockResolvedValue({ jti: "test-jti" }),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ success: true }) })),
          };
        }),
      } as unknown as D1Database;

      const blacklistEnv = {
        ...baseEnv(),
        DB: mockBlacklistDb,
      };

      const req = new Request("http://localhost/api/watchlist", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const res = await worker.fetch(req, blacklistEnv as Env);
      expect(res.status).toBe(401);
      const data = await res.json<{ error: string }>();
      expect(data.error).toBe("Token has been revoked");
    });

    it("DELETE /api/fcm/register should clear FCM token", async () => {
      const mockFcmDb = {
        prepare: vi.fn((query: string) => {
          if (query.includes("SELECT jti FROM jwt_blacklist WHERE jti = ?")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn().mockResolvedValue(null),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({
              run: vi.fn().mockResolvedValue({ success: true }),
            })),
          };
        }),
      } as unknown as D1Database;

      const fcmEnv = {
        ...mockEnv,
        DB: mockFcmDb,
      };

      const req = new Request("http://localhost/api/fcm/register", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const res = await worker.fetch(req, fcmEnv as Env);
      expect(res.status).toBe(200);
      const data = await res.json<{ success: boolean; message: string }>();
      expect(data.success).toBe(true);
      expect(mockFcmDb.prepare).toHaveBeenCalledWith(
        "UPDATE users SET fcm_token = NULL WHERE id = ?",
      );
    });
  });

  it("scheduled handler should run without errors", async () => {
    const mockEnv = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      } as unknown as D1Database,
      RESEND_API_KEY: "test-key",
      ALLOWED_ORIGINS: "https://example.com",
    };
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    await worker.scheduled!({} as ScheduledEvent, mockEnv as Env, ctx);
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it("POST /api/resend-verification sends a new verification email", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });

    const originalFetch = global.fetch;
    (global as any).fetch = mockFetch;

    try {
      const mockDb = {
        prepare: vi.fn((query: string) => {
          if (query.includes("SELECT id, status FROM users WHERE email = ?")) {
            return {
              bind: vi.fn(() => ({
                first: vi.fn().mockResolvedValue({ id: "user-1", status: "PENDING_VERIFICATION" }),
              })),
            };
          }
          if (query.includes("UPDATE users SET verification_token")) {
            return {
              bind: vi.fn(() => ({
                run: vi.fn().mockResolvedValue({ success: true }),
              })),
            };
          }
          return {
            bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ success: true }) })),
          };
        }),
      } as unknown as D1Database;

      const env = {
        ...baseEnv(),
        DB: mockDb,
        RESEND_API_KEY: "test-resend-key",
        RESEND_FROM_EMAIL: "test@example.com",
      };

      const res = await worker.fetch(
        new Request("http://localhost/api/resend-verification", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "pending@example.com" }),
        }),
        env as Env,
      );

      expect(res.status).toBe(200);
      const data = await res.json<{ message: string }>();
      expect(data.message).toBe("Verification email sent.");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.resend.com/emails",
        expect.any(Object),
      );
    } finally {
      (global as any).fetch = originalFetch;
    }
  });

  it("GET /api/verify-email activates a pending account", async () => {
    const token = "test-verification-token";
    const mockDb = {
      prepare: vi.fn((query: string) => {
        if (query.includes("SELECT id, email, status, verification_token_expires_at FROM users WHERE verification_token = ?")) {
          return {
            bind: vi.fn(() => ({
              first: vi.fn().mockResolvedValue({
                id: "user-1",
                email: "verify@example.com",
                status: "PENDING_VERIFICATION",
                verification_token_expires_at: Math.floor(Date.now() / 1000) + 3600,
              }),
            })),
          };
        }
        if (query.includes("UPDATE users SET status = 'ACTIVE'")) {
          return {
            bind: vi.fn(() => ({
              run: vi.fn().mockResolvedValue({ success: true }),
            })),
          };
        }
        return {
          bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ success: true }) })),
        };
      }),
    } as unknown as D1Database;

    const env = {
      ...baseEnv(),
      DB: mockDb,
    };

    const res = await worker.fetch(
      new Request(`http://localhost/api/verify-email?token=${token}`),
      env as Env,
    );

    expect(res.status).toBe(200);
    const data = await res.json<{ message: string }>();
    expect(data.message).toBe("Email verified successfully.");
  });

  describe("PIN Recovery Endpoints", () => {
    it("POST /api/verify-pin returns 200 for valid PIN", async () => {
      const pinHash = await hashPassword("1234");
      const mockEnv = {
        ...baseEnv(),
        DB: {
          prepare: vi.fn((query: string) => {
            if (query.includes("SELECT id, pin_hash, pin_attempts, pin_locked_until FROM users WHERE email = ?")) {
              return {
                bind: vi.fn(() => ({
                  first: vi.fn().mockResolvedValue({
                    id: "user-1",
                    pin_hash: pinHash,
                    pin_attempts: 0,
                    pin_locked_until: null,
                  }),
                })),
              } as any;
            }
            if (query.includes("UPDATE users SET pin_attempts = 0")) {
              return { bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ success: true }) })) } as any;
            }
            return { bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({ success: true }) })) } as any;
          }),
        },
      } as unknown as Env;

      const res = await worker.fetch(
        new Request("http://localhost/api/verify-pin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "user@example.com", pin: "1234" }),
        }),
        mockEnv,
      );

      expect(res.status).toBe(200);
      const data = await res.json<{ success: boolean; user_id: string }>();
      expect(data.success).toBe(true);
      expect(data.user_id).toBe("user-1");
    });

    it("POST /api/reset-pin sends reset email", async () => {
      const mockEnv = {
        ...baseEnv(),
        DB: {
          prepare: vi.fn((query: string) => {
            if (query.includes("SELECT id FROM users WHERE email = ?")) {
              return { bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue({ id: "user-1" }) })) } as any;
            }
            if (query.includes("INSERT INTO pin_reset_tokens")) {
              return { bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ success: true }) })) } as any;
            }
            return { bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({ success: true }) })) } as any;
          }),
        },
      } as unknown as Env;

      const originalFetch = (global as any).fetch;
      (global as any).fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "email-123" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      try {
        const res = await worker.fetch(
          new Request("http://localhost/api/reset-pin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "user@example.com" }),
          }),
          mockEnv,
        );

        expect(res.status).toBe(200);
        const data = await res.json<{ message: string }>();
        expect(data.message).toBe("PIN reset email sent.");
      } finally {
        (global as any).fetch = originalFetch;
      }
    });
  });
});
