import { describe, it, expect } from "vitest";
import { classifyException, classifyExchangeResponse } from "./errors";

describe("Exchange Error Classifier", () => {
  it("classifies Binance API key / IP whitelist error (-2015) correctly", () => {
    const errorBody = JSON.stringify({
      code: -2015,
      msg: "Invalid API-key, IP, or permissions for action, request IP: 192.168.1.1",
    });
    const result = classifyException(new Error(errorBody), "binance");
    expect(result.code).toBe("IP_NOT_WHITELISTED");
    expect(result.hint).toContain("192.168.1.1");
  });

  it("classifies Binance invalid API key error (-2014) correctly", () => {
    const errorBody = JSON.stringify({
      code: -2014,
      msg: "API-key format invalid.",
    });
    const result = classifyException(new Error(errorBody), "binance");
    expect(result.code).toBe("INVALID_API_KEY");
  });

  it("classifies Binance invalid signature error (-1022) correctly", () => {
    const errorBody = JSON.stringify({
      code: -1022,
      msg: "Signature for this request is not valid.",
    });
    const result = classifyException(new Error(errorBody), "binance");
    expect(result.code).toBe("INVALID_SIGNATURE");
  });

  it("classifies Binance timestamp out of sync (-1021) correctly", () => {
    const errorBody = JSON.stringify({
      code: -1021,
      msg: "Timestamp for this request was 1000ms ahead of the server's time.",
    });
    const result = classifyException(new Error(errorBody), "binance");
    expect(result.code).toBe("TIMESTAMP_OUT_OF_SYNC");
  });

  it("classifies KuCoin invalid API key (400001) correctly", () => {
    const errorBody = JSON.stringify({
      code: "400001",
      msg: "Invalid API Key",
    });
    const result = classifyException(new Error(errorBody), "kucoin");
    expect(result.code).toBe("INVALID_API_KEY");
  });

  it("classifies KuCoin invalid passphrase (400004) correctly", () => {
    const errorBody = JSON.stringify({
      code: "400004",
      msg: "Invalid Passphrase",
    });
    const result = classifyException(new Error(errorBody), "kucoin");
    expect(result.code).toBe("INVALID_PASSPHRASE");
  });

  it("classifies Binance Cloudflare WAF block (403 HTML) correctly", () => {
    const htmlBody = "<html><head><title>403 Forbidden</title></head><body>Request blocked by Cloudflare WAF</body></html>";
    const result = classifyExchangeResponse(403, htmlBody, "binance");
    expect(result.code).toBe("WAF_BLOCKED");
  });
});
