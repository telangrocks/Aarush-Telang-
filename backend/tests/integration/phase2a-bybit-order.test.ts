import { describe, it, expect, vi, beforeEach } from "vitest";
import { BybitAdapter } from "../../src/infrastructure/exchange/adapters/BybitAdapter";
import BigNumber from "bignumber.js";
import { UnifiedError } from "../../src/exchanges/models/UnifiedError";

describe("Phase 2A — Bybit-Native Attached TP/SL Order Contract Tests", () => {
  let adapter: BybitAdapter;
  let capturedRequests: any[];

  beforeEach(() => {
    capturedRequests = [];
    adapter = new BybitAdapter({
      exchange: "bybit",
      apiKey: "test_api_key",
      secret: "test_secret_key",
      environment: "demo",
      product: "linear",
      region: "global",
    });

    // Intercept makeRequest to inspect outbound payload
    vi.spyOn(adapter as any, "makeRequest").mockImplementation(async (method: string, path: string, params: any) => {
      capturedRequests.push({ method, path, params });
      if (params.symbol === "INVALIDREJECT" || params.symbol === "INVALID_REJECT") {
        throw new UnifiedError("Invalid TP/SL parameters", "INVALID_REQUEST", 10001, "params error", 400);
      }
      return {
        orderId: "bybit_ord_998877",
        orderLinkId: params.orderLinkId || "link_123",
      };
    });
  });

  it("submits BUY MARKET with Bybit-native attached TP/SL (tpslMode: Full, LastPrice trigger)", async () => {
    const alertId = "c3cbe99c-2750-49f0-91a8-0777be8c3fe2";
    const orderReq: any = {
      symbol: "ZRO/USDT",
      side: "buy",
      type: "market",
      amount: new BigNumber(85.6604),
      clientOrderId: alertId,
      takeProfit: 1.20242,
      stopLoss: 1.14989,
      category: "linear",
    };

    const result = await adapter.createOrder(orderReq);

    expect(result.id).toBe("bybit_ord_998877");
    expect(result.clientOrderId).toBe(alertId);
    expect(result.status).toBe("open");

    expect(capturedRequests.length).toBe(1);
    const req = capturedRequests[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v5/order/create");
    expect(req.params.category).toBe("linear");
    expect(req.params.symbol).toBe("ZROUSDT");
    expect(req.params.side).toBe("Buy");
    expect(req.params.orderType).toBe("Market");
    expect(req.params.qty).toBe("85.6604");
    expect(req.params.orderLinkId).toBe(alertId);
    expect(req.params.takeProfit).toBe("1.20242");
    expect(req.params.stopLoss).toBe("1.14989");
    expect(req.params.tpslMode).toBe("Full");
    expect(req.params.tpTriggerBy).toBe("LastPrice");
    expect(req.params.slTriggerBy).toBe("LastPrice");
    expect(req.params.tpOrderType).toBe("Market");
    expect(req.params.slOrderType).toBe("Market");
    expect(req.params.positionIdx).toBe(0);
  });

  it("submits BUY LIMIT with Bybit-native attached TP/SL", async () => {
    const alertId = "c3cbe99c-2750-49f0-91a8-0777be8c3fe2";
    const orderReq: any = {
      symbol: "ZRO/USDT",
      side: "buy",
      type: "limit",
      price: new BigNumber(1.1674),
      amount: new BigNumber(85.6604),
      clientOrderId: alertId,
      takeProfit: 1.20242,
      stopLoss: 1.14989,
      category: "linear",
    };

    const result = await adapter.createOrder(orderReq);

    expect(result.id).toBe("bybit_ord_998877");
    expect(result.status).toBe("open");

    expect(capturedRequests.length).toBe(1);
    const req = capturedRequests[0];
    expect(req.params.orderType).toBe("Limit");
    expect(req.params.price).toBe("1.1674");
    expect(req.params.takeProfit).toBe("1.20242");
    expect(req.params.stopLoss).toBe("1.14989");
    expect(req.params.tpslMode).toBe("Full");
  });

  it("submits SELL MARKET with Bybit-native attached TP/SL", async () => {
    const alertId = "alert_sell_123";
    const orderReq: any = {
      symbol: "BTC/USDT",
      side: "sell",
      type: "market",
      amount: new BigNumber(0.05),
      clientOrderId: alertId,
      takeProfit: 55000,
      stopLoss: 62000,
      category: "linear",
    };

    const result = await adapter.createOrder(orderReq);

    expect(result.id).toBe("bybit_ord_998877");
    const req = capturedRequests[0];
    expect(req.params.side).toBe("Sell");
    expect(req.params.takeProfit).toBe("55000");
    expect(req.params.stopLoss).toBe("62000");
    expect(req.params.tpslMode).toBe("Full");
  });

  it("strictly enforces zero-unprotected-entry invariant (aborts on TP/SL rejection, no naked fallback)", async () => {
    const alertId = "alert_reject_123";
    const orderReq: any = {
      symbol: "INVALID_REJECT",
      side: "buy",
      type: "market",
      amount: new BigNumber(10),
      clientOrderId: alertId,
      takeProfit: 1.5,
      stopLoss: 0.5,
      category: "linear",
    };

    await expect(adapter.createOrder(orderReq)).rejects.toThrow(UnifiedError);

    // Verify exactly 1 request was attempted and no subsequent naked order was submitted
    expect(capturedRequests.length).toBe(1);
  });
});
