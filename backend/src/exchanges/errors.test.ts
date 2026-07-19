import { describe, it, expect } from "vitest";
import {
  classifyBinanceCode,
  classifyBybitCode,
  classifyDeltaCode,
  classifyByBodyText,
  classifyExchangeResponse,
} from "./errors";

const detail = (body: string, exchange = "binance") =>
  `exchange=${exchange} status=401 body=${body}`;

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

describe("Bybit structured error retCode classification", () => {
  it("maps retCode 10003 (API key invalid) to INVALID_API_KEY", () => {
    const err = classifyBybitCode(
      '{"retCode":10003,"retMsg":"API key is invalid.","result":{},"retExtInfo":{},"time":1}',
      detail('{"retCode":10003,"retMsg":"API key is invalid."}', "bybit"),
    );
    expect(err?.code).toBe("INVALID_API_KEY");
  });

  it("maps retCode 10005/10006 (permission) to INSUFFICIENT_PERMISSIONS", () => {
    expect(
      classifyBybitCode('{"retCode":10005,"retMsg":"api key not authorized"}', "x")?.code,
    ).toBe("INSUFFICIENT_PERMISSIONS");
    expect(
      classifyBybitCode('{"retCode":10006,"retMsg":"insufficient permission"}', "x")?.code,
    ).toBe("INSUFFICIENT_PERMISSIONS");
  });

  it("maps retCode 10009 (timestamp expired) to TIMESTAMP_OUT_OF_SYNC", () => {
    const err = classifyBybitCode('{"retCode":10009,"retMsg":"api timestamp expired"}', "x");
    expect(err?.code).toBe("TIMESTAMP_OUT_OF_SYNC");
  });

  it("maps retCode 10010/10012 (invalid sign) to INVALID_SIGNATURE", () => {
    expect(classifyBybitCode('{"retCode":10010,"retMsg":"invalid sign"}', "x")?.code).toBe(
      "INVALID_SIGNATURE",
    );
    expect(classifyBybitCode('{"retCode":10012,"retMsg":"invalid parameter"}', "x")?.code).toBe(
      "INVALID_SIGNATURE",
    );
  });

  it("maps retCode 10013 (ip not allowed) to IP_NOT_WHITELISTED", () => {
    const err = classifyBybitCode('{"retCode":10013,"retMsg":"ip not allowed"}', "x");
    expect(err?.code).toBe("IP_NOT_WHITELISTED");
  });

  it("maps retCode 10018/10029 (rate limit) to API_RATE_LIMIT_REACHED", () => {
    expect(classifyBybitCode('{"retCode":10018,"retMsg":"too many visits"}', "x")?.code).toBe(
      "API_RATE_LIMIT_REACHED",
    );
    expect(classifyBybitCode('{"retCode":10029,"retMsg":"frequency limit"}', "x")?.code).toBe(
      "API_RATE_LIMIT_REACHED",
    );
  });

  it("maps spot/futures not-enabled retCodes to the right codes", () => {
    expect(classifyBybitCode('{"retCode":110007,"retMsg":"spot not enabled"}', "x")?.code).toBe(
      "SPOT_TRADING_NOT_ENABLED",
    );
    expect(classifyBybitCode('{"retCode":160003,"retMsg":"contract not enabled"}', "x")?.code).toBe(
      "FUTURES_TRADING_NOT_ENABLED",
    );
  });

  it("returns null for unrecognised retCodes", () => {
    expect(classifyBybitCode('{"retCode":99999,"retMsg":"weird"}', "x")).toBeNull();
  });

  it("classifyExchangeResponse resolves Bybit retCode on a 401", () => {
    const err = classifyExchangeResponse(
      401,
      '{"retCode":10003,"retMsg":"API key is invalid."}',
      "bybit",
    );
    expect(err.code).toBe("INVALID_API_KEY");
  });

  it("classifyByBodyText resolves Bybit retCode", () => {
    const lower = '{"retcode":10003,"retmsg":"api key is invalid."}'.toLowerCase();
    const err = classifyByBodyText(
      lower,
      detail('{"retCode":10003,"retMsg":"API key is invalid."}', "bybit"),
      "bybit",
    );
    expect(err.code).toBe("INVALID_API_KEY");
  });
});

describe("Delta Exchange structured error code classification", () => {
  it("maps invalid_api_key to INVALID_API_KEY", () => {
    const err = classifyDeltaCode(
      '{"success":false,"error":{"code":"invalid_api_key","message":"Invalid API Key"}}',
      'exchange=delta status=401 body={"success":false,"error":{"code":"invalid_api_key"}}',
    );
    expect(err?.code).toBe("INVALID_API_KEY");
  });

  it("maps signature_invalid to INVALID_SIGNATURE", () => {
    const err = classifyDeltaCode(
      '{"success":false,"error":{"code":"signature_invalid","message":"Invalid signature"}}',
      'exchange=delta status=401 body={"success":false,"error":{"code":"signature_invalid"}}',
    );
    expect(err?.code).toBe("INVALID_SIGNATURE");
  });

  it("maps rate_limit_exceeded to API_RATE_LIMIT_REACHED", () => {
    const err = classifyDeltaCode(
      '{"success":false,"error":{"code":"rate_limit_exceeded","message":"Too many requests"}}',
      'exchange=delta status=429 body={"success":false,"error":{"code":"rate_limit_exceeded"}}',
    );
    expect(err?.code).toBe("API_RATE_LIMIT_REACHED");
  });

  it("classifyExchangeResponse resolves Delta code on a 400/401", () => {
    const err = classifyExchangeResponse(
      400,
      '{"success":false,"error":{"code":"invalid_api_key","message":"Invalid API Key"}}',
      "delta",
    );
    expect(err.code).toBe("INVALID_API_KEY");
  });
});

