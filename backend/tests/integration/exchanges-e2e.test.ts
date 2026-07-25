import { describe, it, expect, beforeEach } from "vitest";
import { getExchangeAdapter, getSupportedExchangeNames } from "../../src/exchanges/ExchangeFactory";
import { WebSocketManager } from "../../src/exchanges/WebSocketManager";
import { BinanceExchange } from "../../src/exchanges/BinanceExchange";
import { BybitExchange } from "../../src/exchanges/BybitExchange";
import { DeltaExchange } from "../../src/exchanges/DeltaExchange";
import { cleanCredential } from "../../src/crypto";

describe("Multi-Exchange Integration & Architectural Alignment E2E Tests", () => {
  it("should support all three target exchanges in ExchangeFactory", () => {
    const supported = getSupportedExchangeNames();
    expect(supported).toContain("binance");
    expect(supported).toContain("bybit");
    expect(supported).toContain("delta");
  });

  describe("Environment & Region URL Switching", () => {
    it("should correctly resolve Binance REST URLs for mainnet and testnet", () => {
      const mainnet = getExchangeAdapter("binance", "mainnet", "global");
      const testnet = getExchangeAdapter("binance", "testnet", "global");
      expect(mainnet.getRestUrl()).toBe("https://api.binance.com");
      expect(testnet.getRestUrl()).toBe("https://testnet.binance.vision");
    });

    it("should correctly resolve Bybit REST URLs for mainnet and testnet", () => {
      const mainnet = getExchangeAdapter("bybit", "mainnet", "global");
      const testnet = getExchangeAdapter("bybit", "testnet", "global");
      expect(mainnet.getRestUrl()).toBe("https://api.bybit.com");
      expect(testnet.getRestUrl()).toBe("https://api-testnet.bybit.com");
    });

    it("should correctly resolve Delta REST URLs for mainnet and testnet across regions", () => {
      const mainnetIndia = getExchangeAdapter("delta", "mainnet", "india");
      const testnetIndia = getExchangeAdapter("delta", "testnet", "india");
      const testnetGlobal = getExchangeAdapter("delta", "testnet", "global");
      expect(mainnetIndia.getRestUrl()).toBe("https://api.india.delta.exchange");
      expect(testnetIndia.getRestUrl()).toBe("https://cdn-ind.testnet.deltaex.org");
      expect(testnetGlobal.getRestUrl()).toBe("https://api-testnet.delta.exchange");
    });
  });

  describe("Circuit Breaker & Observability Metrics Alignment", () => {
    it("should have circuit breaker initialized and metrics exposed for Binance", () => {
      const adapter = getExchangeAdapter("binance", "mainnet") as BinanceExchange;
      expect(adapter.breaker).toBeDefined();
      expect(adapter.cacheMetrics.circuitBreakerStatus()).toBe("CLOSED");
    });

    it("should have circuit breaker initialized and metrics exposed for Bybit", () => {
      const adapter = getExchangeAdapter("bybit", "mainnet") as BybitExchange;
      expect(adapter.breaker).toBeDefined();
      expect(adapter.cacheMetrics.circuitBreakerStatus()).toBe("CLOSED");
    });

    it("should have circuit breaker initialized and metrics exposed for Delta", () => {
      const adapter = getExchangeAdapter("delta", "mainnet") as DeltaExchange;
      expect(adapter.breaker).toBeDefined();
      expect(adapter.cacheMetrics.circuitBreakerStatus()).toBe("CLOSED");
    });
  });

  describe("WebSocket Manager Alignment & Event Normalization", () => {
    let wsManager: WebSocketManager;

    beforeEach(() => {
      wsManager = new WebSocketManager();
    });

    it("should generate correct WebSocket URLs for all exchanges and environments", () => {
      expect(wsManager.getWebSocketUrl("binance", "mainnet", "global", "lk123")).toBe("wss://stream.binance.com:9443/ws/lk123");
      expect(wsManager.getWebSocketUrl("binance", "testnet", "global", "lk123")).toBe("wss://testnet.binance.vision/ws/lk123");

      expect(wsManager.getWebSocketUrl("bybit", "mainnet")).toBe("wss://stream.bybit.com/v5/private");
      expect(wsManager.getWebSocketUrl("bybit", "testnet")).toBe("wss://stream-testnet.bybit.com/v5/private");

      expect(wsManager.getWebSocketUrl("delta", "mainnet", "india")).toBe("wss://socket.india.delta.exchange");
      expect(wsManager.getWebSocketUrl("delta", "testnet", "india")).toBe("wss://socket-ind.testnet.deltaex.org");
    });

    it("should correctly normalize Binance execution report events", () => {
      const binancePayload = {
        e: "executionReport",
        E: 1680000000000,
        s: "BTCUSDT",
        c: "client_order_1",
        S: "BUY",
        o: "LIMIT",
        f: "GTC",
        q: "0.10000000",
        p: "50000.00000000",
        x: "TRADE",
        X: "FILLED",
        i: 12345678,
        l: "0.10000000",
        z: "0.10000000",
        Z: "5000.00000000",
        T: 1680000000000,
      };

      const event = wsManager.normalizeBinanceExecutionReport(binancePayload);
      expect(event).not.toBeNull();
      expect(event?.exchange).toBe("binance");
      expect(event?.symbol).toBe("BTC");
      expect(event?.side).toBe("BUY");
      expect(event?.status).toBe("filled");
      expect(event?.filledQuantity).toBe(0.1);
      expect(event?.averageFillPrice).toBe(50000);
    });

    it("should correctly normalize Bybit order stream events", () => {
      const bybitPayload = {
        topic: "order",
        data: [{
          orderId: "bybit_123",
          orderLinkId: "link_123",
          symbol: "BTCUSDT",
          side: "Buy",
          orderStatus: "Filled",
          price: "50000.00",
          qty: "0.1",
          cumExecQty: "0.1",
          avgPrice: "50000.00",
          updatedTime: "1680000000000"
        }]
      };

      const event = wsManager.normalizeBybitOrderEvent(bybitPayload);
      expect(event).not.toBeNull();
      expect(event?.exchange).toBe("bybit");
      expect(event?.symbol).toBe("BTC");
      expect(event?.side).toBe("BUY");
      expect(event?.status).toBe("filled");
      expect(event?.filledQuantity).toBe(0.1);
      expect(event?.averageFillPrice).toBe(50000);
    });

    it("should correctly generate WebSocket ping payloads for heartbeats", () => {
      expect(wsManager.getPingPayload("bybit")).toBe('{"op":"ping"}');
      expect(wsManager.getPingPayload("delta")).toBe('{"type":"ping"}');
      expect(wsManager.getPingPayload("binance")).toBeNull();
    });

    it("should correctly normalize Delta Exchange order stream events", () => {
      const deltaPayload = {
        type: "orders",
        payload: {
          id: 998877,
          client_order_id: "delta_client_1",
          symbol: "BTCUSD",
          side: "buy",
          state: "closed",
          size: "0.1",
          filled_quantity: "0.1",
          avg_fill_price: "50000.00",
          limit_price: "50000.00",
          updated_at: "2026-07-24T12:00:00.000Z"
        }
      };

      const event = wsManager.normalizeDeltaOrderEvent(deltaPayload);
      expect(event).not.toBeNull();
      expect(event?.exchange).toBe("delta");
      expect(event?.symbol).toBe("BTC");
      expect(event?.side).toBe("BUY");
      expect(event?.status).toBe("filled");
      expect(event?.filledQuantity).toBe(0.1);
      expect(event?.averageFillPrice).toBe(50000);
    });
  });

  describe("Credential Sanitization Utility", () => {
    it("should strip wrapping single and double quotes, zero-width spaces, and whitespace", () => {
      const dirtyKey = '  "key_12345\u200B\uFEFF" ';
      const dirtySecret = " 'secret_67890' \u200C";
      expect(cleanCredential(dirtyKey)).toBe("key_12345");
      expect(cleanCredential(dirtySecret)).toBe("secret_67890");
    });
  });
});
