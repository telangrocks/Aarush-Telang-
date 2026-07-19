import { describe, it, expect } from "vitest";
import {
  classifyBinanceCode,
  classifyByBodyText,
  classifyExchangeResponse,
} from "./errors";

const detail = (body: string) => `exchange=binance status=401 body=${body}`;

describe("Binance structured error code classification", () => {
  it("maps API-key format invalid (-2014) to INVALID_API_KEY", () => {
    const err = classifyBinanceCode(
      '{"code":-2014,"msg":"API-key format invalid."}',
      detail('{"code":-2014,"msg":"API-key format invalid."}'),
    );
    expect(err?.code).toBe("INVALID_API_KEY");
  });

  it("maps -2015 (invalid key/IP/permissions) to INVALID_API_KEY", () => {
    const err = classifyBinanceCode(
      '{"code":-2015,"msg":"Invalid API-key, IP, or permissions."}',
      detail('{"code":-2015,"msg":"Invalid API-key, IP, or permissions."}'),
    );
    expect(err?.code).toBe("INVALID_API_KEY");
  });

  it("maps invalid signature (-1022) to INVALID_SIGNATURE", () => {
    const err = classifyBinanceCode(
      '{"code":-1022,"msg":"Signature for this request is not valid."}',
      detail('{"code":-1022,"msg":"Signature for this request is not valid."}'),
    );
    expect(err?.code).toBe("INVALID_SIGNATURE");
  });

  it("maps timestamp out of recvWindow (-1021) to TIMESTAMP_OUT_OF_SYNC", () => {
    const err = classifyBinanceCode(
      '{"code":-1021,"msg":"Timestamp for this request was outside of the recvWindow."}',
      detail('{"code":-1021,"msg":"Timestamp for this request was outside of the recvWindow."}'),
    );
    expect(err?.code).toBe("TIMESTAMP_OUT_OF_SYNC");
  });

  it("maps rate limit (-1003) to API_RATE_LIMIT_REACHED", () => {
    const err = classifyBinanceCode(
      '{"code":-1003,"msg":"Too much request weight used."}',
      detail('{"code":-1003,"msg":"Too much request weight used."}'),
    );
    expect(err?.code).toBe("API_RATE_LIMIT_REACHED");
  });

  it("maps futures-not-enabled (-2027) to FUTURES_TRADING_NOT_ENABLED", () => {
    const err = classifyBinanceCode(
      '{"code":-2027,"msg":"Futures trading is not enabled on this account."}',
      detail('{"code":-2027,"msg":"Futures trading is not enabled on this account."}'),
    );
    expect(err?.code).toBe("FUTURES_TRADING_NOT_ENABLED");
  });

  it("returns null for unrecognised codes so text heuristics can take over", () => {
    const err = classifyBinanceCode(
      '{"code":-9999,"msg":"something odd"}',
      detail('{"code":-9999,"msg":"something odd"}'),
    );
    expect(err).toBeNull();
  });

  it("classifyByBodyText prefers the structured Binance code", () => {
    const lower = '{"code":-2014,"msg":"api-key format invalid."}'.toLowerCase();
    const err = classifyByBodyText(lower, detail('{"code":-2014,"msg":"API-key format invalid."}'), "binance");
    expect(err.code).toBe("INVALID_API_KEY");
  });

  it("classifyExchangeResponse uses the Binance code for a 401", () => {
    const err = classifyExchangeResponse(
      401,
      '{"code":-2014,"msg":"API-key format invalid."}',
      "binance",
    );
    expect(err.code).toBe("INVALID_API_KEY");
  });
});
