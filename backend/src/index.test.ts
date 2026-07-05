import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "./index";
import { Env } from "./index";
import { sign } from "hono/jwt";

describe("App Endpoints", () => {
  it("GET /health returns status ok", async () => {
    const res = await worker.fetch(new Request("http://localhost/health"));
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
    ]);
  });

  it("GET /db-status returns error when DB fails", async () => {
    // Mock the environment
    const mockEnv = {
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

  describe("Protected API Endpoints", () => {
    let mockEnv: Partial<Env>;
    let token: string;
    const userId = "user-123";

    beforeEach(async () => {
      const all = vi
        .fn()
        .mockResolvedValue({ results: [{ id: "btc", user_id: userId }] });
      const run = vi.fn().mockResolvedValue({ success: true });
      const bind = vi.fn(() => ({ all, run }));
      const statement = { bind };

      mockEnv = {
        DB: {
          prepare: vi.fn(() => statement),
        } as unknown as D1Database,
        ENCRYPTION_KEY: "test-encryption-key",
        JWT_SECRET: "test-secret",
        RESEND_API_KEY: "test-resend-key",
        PRICE_CACHE: {} as KVNamespace,
        TRADING_BOTS: {} as DurableObjectNamespace,
      };
      token = await sign(
        { sub: userId, email: "test@test.com" },
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

    it("POST /api/exchange/keys should store encrypted keys", async () => {
      const body = { apiKey: "test-api-key", apiSecret: "test-api-secret" };
      const req = new Request("http://localhost/api/exchange/keys", {
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
        "UPDATE users SET exchange_api_key = ?, exchange_api_secret_iv = ?, exchange_api_secret_encrypted = ? WHERE id = ?",
      );
      expect(mockEnv.DB?.prepare("stmt").bind).toHaveBeenCalledWith(
        "test-api-key",
        expect.any(String),
        expect.any(String),
        userId,
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
    };
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    await worker.scheduled!({} as ScheduledEvent, mockEnv as Env, ctx);
    expect(ctx.waitUntil).toHaveBeenCalled();
  });
});
