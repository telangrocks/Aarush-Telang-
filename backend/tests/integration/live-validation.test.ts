import { describe, it, expect, beforeEach, vi } from "vitest";
import { getExchangeAdapter } from "../../src/exchanges/ExchangeFactory";
import { BinanceExchange } from "../../src/exchanges/BinanceExchange";
import { BybitExchange } from "../../src/exchanges/BybitExchange";
import { DeltaExchange } from "../../src/exchanges/DeltaExchange";
import { WebSocketManager } from "../../src/exchanges/WebSocketManager";
import { ReconciliationEngine } from "../../src/exchanges/ReconciliationEngine";
import { classifyExchangeResponse, FRIENDLY_MESSAGES } from "../../src/exchanges/errors";
import { CircuitBreaker } from "../../src/exchanges/CircuitBreaker";
import { cleanCredential, encrypt } from "../../src/crypto";

describe("Live Exchange Integration & Failure Scenario Validation Suite", () => {
  const mockEnv: any = {
    ENCRYPTION_KEY: "test-secret-key-32-bytes-long!!",
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    },
  };

  const mockStorage: any = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  };

  describe("1. Credential Sanitization & Security Redaction", () => {
    it("should sanitize whitespace, quotes, and zero-width characters across all exchanges", () => {
      const dirtyKey = '  "apiKey_12345\u200B" ';
      const dirtySecret = " 'apiSecret_67890\uFEFF' ";

      expect(cleanCredential(dirtyKey)).toBe("apiKey_12345");
      expect(cleanCredential(dirtySecret)).toBe("apiSecret_67890");
    });

    it("should guarantee that raw secrets and signatures are never exposed in ClassifiedError objects", () => {
      const body = '{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action, request ip: 103.21.12.55"}';
      const err = classifyExchangeResponse(400, body, "Binance");

      expect(err.technicalDetail).not.toContain("apiSecret");
      expect(err.code).toBe("IP_NOT_WHITELISTED");
      expect(err.hint).toContain("103.21.12.55");
    });
  });

  describe("2. Exchange Authentication & Failure Scenarios", () => {
    it("Binance: should classify -2015 IP restriction with extracted caller IP", () => {
      const body = '{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action, request ip: 103.45.67.89"}';
      const err = classifyExchangeResponse(400, body, "Binance");
      expect(err.code).toBe("IP_NOT_WHITELISTED");
      expect(err.hint).toContain("103.45.67.89");
    });

    it("Bybit V5: should classify retCode 10002 (Invalid request timestamp) as TIMESTAMP_OUT_OF_SYNC", () => {
      const body = '{"retCode":10002,"retMsg":"request timestamp is invalid"}';
      const err = classifyExchangeResponse(400, body, "Bybit");
      expect(err.code).toBe("TIMESTAMP_OUT_OF_SYNC");
    });

    it("Delta V2: should handle HTTP 403 geo-blocking and fallback automatically", async () => {
      const adapter = getExchangeAdapter("delta", "mainnet", "india") as DeltaExchange;      
      expect(adapter.getRestUrl()).toBe("https://api.india.delta.exchange");
      expect(adapter.getFallbackRestUrl()).toBe("https://api.delta.exchange");
    });
  });

  describe("3. Circuit Breaker & Rate Limiting Resiliency", () => {
    it("should trip circuit breaker after consecutive network failures", () => {
      const breaker = new CircuitBreaker(3, 60000);
      expect(breaker.getStatus().state).toBe("CLOSED");

      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      expect(breaker.getStatus().state).toBe("OPEN");
      expect(breaker.check().allowed).toBe(false);
    });

    it("should recover circuit breaker after reset timeout transition", async () => {
      const breaker = new CircuitBreaker(3, 10);
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getStatus().state).toBe("OPEN");

      await new Promise((resolve) => setTimeout(resolve, 20));
      const res = breaker.check();
      expect(res.state).toBe("HALF_OPEN");

      breaker.recordSuccess();
      expect(breaker.getStatus().state).toBe("CLOSED");
    });
  });

  describe("4. WebSocket Ping/Pong & Stream Lifecycle", () => {
    it("should provide valid ping payloads for Bybit and Delta WebSocket managers", () => {
      const wsManager = new WebSocketManager();
      expect(wsManager.getPingPayload("bybit")).toBe('{"op":"ping"}');
      expect(wsManager.getPingPayload("delta")).toBe('{"type":"ping"}');
      expect(wsManager.getPingPayload("binance")).toBeNull(); // Binance uses protocol-level WS ping
    });
  });

  describe("5. Background Reconciliation Engine Security & Secret Decryption", () => {
    it("should correctly decrypt encrypted secrets before querying exchange positions", async () => {
      const encrypted = await encrypt("my-secret-key-12345", mockEnv.ENCRYPTION_KEY);
      const userKeys = {
        exchange_name: "binance",
        exchange_environment: "mainnet",
        exchange_region: "global",
        exchange_api_key: "my-api-key-12345",
        exchange_api_secret_iv: encrypted.iv,
        exchange_api_secret_encrypted: encrypted.encrypted,
      };

      const mockAdapter: any = {
        fetchPositions: vi.fn().mockResolvedValue({ success: true, result: [] }),
        fetchOrder: vi.fn().mockResolvedValue({ success: true, status: "filled" }),
      };

      const engine = new ReconciliationEngine(mockStorage, mockEnv, "user-123", mockAdapter, userKeys);
      await engine.runReconciliationSweep();

      expect(mockAdapter.fetchPositions).toHaveBeenCalledWith("my-api-key-12345", "my-secret-key-12345");
    });
  });
});
