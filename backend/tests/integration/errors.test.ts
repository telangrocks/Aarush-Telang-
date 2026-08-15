import { describe, it, expect } from "vitest";
import {
  classifyByBodyText,
  classifyExchangeResponse,
} from "../../src/exchanges/errors";
import { ExchangeSpecificationRegistry } from "../../src/exchanges/registry/ExchangeSpecificationRegistry";

const detail = (body: string, exchange = "bybit") =>
  `exchange=${exchange} status=401 body=${body}`;

describe("Bybit structured error code classification", () => {
  it("maps invalid API key (10002) to INVALID_API_KEY", () => {
    const spec = ExchangeSpecificationRegistry.getInstance().getSpecification('bybit');
    const mapped = spec?.mapper.mapErrorPayload(401, '{"retCode":10002,"retMsg":"invalid api_key"}', {}, detail('{"retCode":10002}'));
    expect(mapped?.code).toBe("INVALID_API_KEY");
  });

  it("maps invalid signature (10004) to INVALID_SIGNATURE", () => {
    const spec = ExchangeSpecificationRegistry.getInstance().getSpecification('bybit');
    const mapped = spec?.mapper.mapErrorPayload(400, '{"retCode":10004,"retMsg":"Error sign"}', {}, detail('{"retCode":10004}'));
    expect(mapped?.code).toBe("INVALID_SIGNATURE");
  });

  it("maps timestamp out of recvWindow (10003) to TIMESTAMP_OUT_OF_SYNC", () => {
    const spec = ExchangeSpecificationRegistry.getInstance().getSpecification('bybit');
    const mapped = spec?.mapper.mapErrorPayload(400, '{"retCode":10003,"retMsg":"req timestamp exceeds recv_window"}', {}, detail('{"retCode":10003}'));
    expect(mapped?.code).toBe("TIMESTAMP_OUT_OF_SYNC");
  });

  it("returns classified error DTO for unrecognised codes with fallback friendly message", () => {
    const spec = ExchangeSpecificationRegistry.getInstance().getSpecification('bybit');
    const mapped = spec?.mapper.mapErrorPayload(400, '{"retCode":-9999,"retMsg":"something odd"}', {}, 'tech');
    expect(mapped?.code).toBe("INVALID_REQUEST");
  });

  it("classifyExchangeResponse classifies 401 with invalid api key body as INVALID_API_KEY", () => {
    const err = classifyExchangeResponse(
      401,
      '{"retCode":10002,"retMsg":"invalid api_key"}',
      "bybit",
    );
    expect(err.code).toBe("INVALID_API_KEY");
  });
});



