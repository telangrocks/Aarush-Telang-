import { describe, it, expect } from "vitest";
import { classifyException, classifyExchangeResponse } from "./errors";

describe("Exchange Error Classifier", () => {
  it("classifies Bybit invalid API key error (10002) correctly", () => {
    const errorBody = JSON.stringify({
      retCode: 10002,
      retMsg: "invalid api_key",
    });
    const result = classifyException(new Error(errorBody), "bybit");
    expect(result.code).toBe("INVALID_API_KEY");
  });

  it("classifies Bybit timestamp out of sync (10003) correctly", () => {
    const errorBody = JSON.stringify({
      retCode: 10003,
      retMsg: "req timestamp exceeds recv_window",
    });
    const result = classifyException(new Error(errorBody), "bybit");
    expect(result.code).toBe("TIMESTAMP_OUT_OF_SYNC");
  });

  it("classifies Bybit invalid signature error (10004) correctly", () => {
    const errorBody = JSON.stringify({
      retCode: 10004,
      retMsg: "Error sign",
    });
    const result = classifyException(new Error(errorBody), "bybit");
    expect(result.code).toBe("INVALID_SIGNATURE");
  });

  it("classifies Bybit IP restricted error (10010) correctly", () => {
    const errorBody = JSON.stringify({
      retCode: 10010,
      retMsg: "Unmatched IP address",
    });
    const result = classifyException(new Error(errorBody), "bybit");
    expect(result.code).toBe("IP_NOT_WHITELISTED");
  });

  it("classifies Bybit Cloudflare WAF block (403 HTML) correctly", () => {
    const htmlBody = "<html><head><title>403 Forbidden</title></head><body>Request blocked by Cloudflare WAF</body></html>";
    const result = classifyExchangeResponse(403, htmlBody, "bybit");
    expect(result.code).toBe("WAF_BLOCKED");
  });
});
