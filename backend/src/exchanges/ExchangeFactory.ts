import { IExchangeAdapter } from "./BaseExchange";
import { ExchangeName, ExchangeEnvironment, ExchangeRegion } from "./types";
import { BinanceExchange } from "./BinanceExchange";
import { DeltaExchange } from "./DeltaExchange";
import { BybitExchange } from "./BybitExchange";

const adapterConstructors: Record<ExchangeName, new () => IExchangeAdapter> = {
  binance: BinanceExchange,
  delta: DeltaExchange,
  bybit: BybitExchange,
};

/**
 * Normalize an untrusted region value into a valid ExchangeRegion.
 * Falls back to the adapter's configured defaultRegion (Delta defaults to
 * "india" so Indian accounts are routed to the India domain by default).
 */
export function normalizeRegion(value: unknown, defaultRegion: ExchangeRegion): ExchangeRegion {
  return value === "global" || value === "india" ? value : defaultRegion;
}

/**
 * Resolve an exchange adapter for the given exchange, configured for the
 * requested environment (defaults to "mainnet") and region (defaults to the
 * exchange's configured defaultRegion). Selecting "testnet" points the
 * adapter at the exchange's sandbox/testnet REST endpoint for BOTH credential
 * validation and all subsequent API calls.
 */
export function getExchangeAdapter(
  name: ExchangeName,
  environment: ExchangeEnvironment = "mainnet",
  region?: ExchangeRegion,
): IExchangeAdapter {
  const AdapterCtor = adapterConstructors[name];
  if (!AdapterCtor) {
    throw new Error(`Unsupported exchange: ${name}`);
  }
  const adapter = new AdapterCtor();
  const resolvedRegion = normalizeRegion(region, adapter.config.defaultRegion);
  if (adapter.setRegion) {
    adapter.setRegion(resolvedRegion);
  }
  if (adapter.setEnvironment) {
    adapter.setEnvironment(environment);
  }
  return adapter;
}

export function getSupportedExchangeNames(): ExchangeName[] {
  return Object.keys(adapterConstructors) as ExchangeName[];
}
