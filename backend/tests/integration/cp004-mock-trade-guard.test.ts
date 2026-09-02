import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "../../src/index";
import { handleMockTrade } from "../../src/handlers/exchange";

describe("CP-004: Production Mock-Trade Hardening Guard", () => {
  let mockEnv: any;
  let mockContext: any;
  let mockBotFetch: any;

  beforeEach(() => {
    mockBotFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, message: "Mock trade simulated" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    mockEnv = {
      ENVIRONMENT: "production",
      JWT_SECRET: "test-jwt-secret-key-32-chars-long!",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      RESEND_API_KEY: "re_test_123456789",
      ALLOWED_ORIGINS: "http://localhost:3000,https://app.cryptopulse.io",
      DB: {
        prepare: vi.fn()
      },
      TRADING_BOTS: {
        idFromName: vi.fn().mockReturnValue("mock-bot-id"),
        get: vi.fn().mockReturnValue({
          fetch: mockBotFetch
        })
      }
    };
  });

  it("Test 1: Unauthenticated request to /api/trading-bot/mock-trade returns 401 Unauthorized", async () => {
    const res = await app.request("/api/trading-bot/mock-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://app.cryptopulse.io" },
      body: JSON.stringify({ symbol: "BTC/USDT", side: "BUY" })
    }, mockEnv);

    expect(res.status).toBe(401);
  });

  it("Test 2: Authenticated request with ENVIRONMENT = 'production' returns 403 Forbidden and MOCK_TRADING_DISABLED", async () => {
    mockContext = {
      env: { ...mockEnv, ENVIRONMENT: "production" },
      get: vi.fn().mockReturnValue({ sub: "usr_test_123" }),
      req: {
        json: vi.fn().mockResolvedValue({ symbol: "BTC/USDT", side: "BUY" })
      },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => new Response(JSON.stringify(data), { status: 403 }))
    };

    await handleMockTrade(mockContext);
    expect(mockContext.status).toHaveBeenCalledWith(403);

    const jsonCall = mockContext.json.mock.calls[0][0];
    expect(jsonCall.success).toBe(false);
    expect(jsonCall.code).toBe("MOCK_TRADING_DISABLED");
    expect(jsonCall.error).toBe("Mock trading is disabled in production.");
    expect(jsonCall.message).toBe("Mock trading is disabled in production.");
  });

  it("Test 3 & 4: Production rejection occurs before DO invocation and causes zero DO/D1 calls", async () => {
    mockContext = {
      env: { ...mockEnv, ENVIRONMENT: "production" },
      get: vi.fn().mockReturnValue({ sub: "usr_test_123" }),
      req: {
        json: vi.fn().mockResolvedValue({ symbol: "BTC/USDT", side: "BUY" })
      },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => new Response(JSON.stringify(data), { status: 403 }))
    };

    await handleMockTrade(mockContext);

    // Verify DO was never retrieved or fetched
    expect(mockEnv.TRADING_BOTS.idFromName).not.toHaveBeenCalled();
    expect(mockEnv.TRADING_BOTS.get).not.toHaveBeenCalled();
    expect(mockBotFetch).not.toHaveBeenCalled();

    // Verify D1 was never touched
    expect(mockEnv.DB.prepare).not.toHaveBeenCalled();
  });

  it("Test 5: Authenticated request in non-production (ENVIRONMENT = 'test') preserves existing simulation behavior", async () => {
    mockContext = {
      env: { ...mockEnv, ENVIRONMENT: "test" },
      get: vi.fn().mockReturnValue({ sub: "usr_test_123" }),
      req: {
        json: vi.fn().mockResolvedValue({ symbol: "BTC/USDT", side: "BUY" })
      },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data) => new Response(JSON.stringify(data), { status: 200 }))
    };

    await handleMockTrade(mockContext);

    // Verify DO WAS called when not in production
    expect(mockEnv.TRADING_BOTS.idFromName).toHaveBeenCalledWith("usr_test_123");
    expect(mockEnv.TRADING_BOTS.get).toHaveBeenCalledWith("mock-bot-id");
    expect(mockBotFetch).toHaveBeenCalled();
    expect(mockContext.status).toHaveBeenCalledWith(200);
  });

  it("Test 6: Real execution route (/api/trading-bot/execute-trade) remains mounted and unaffected", async () => {
    // An unauthenticated request to /execute-trade hits JWT middleware (401), proving route is intact
    const res = await app.request("/api/trading-bot/execute-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://app.cryptopulse.io" },
      body: JSON.stringify({ alertId: "some-alert-id" })
    }, mockEnv);

    expect(res.status).toBe(401);
  });
});
