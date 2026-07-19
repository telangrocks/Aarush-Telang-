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

const adapterCache = new Map<string, IExchangeAdapter>();

/**
 * Resolve an exchange adapter for the given exchange, configured for the
 * requested environment (defaults to "mainnet") and region (defaults to the
 * exchange's configured defaultRegion). Selecting "testnet" points the
 * adapter at the exchange's sandbox/testnet REST endpoint for BOTH credential
 * validation and all subsequent API calls.
 * 
 * Adapters are cached per unique configuration to preserve underlying metrics
 * and caching mechanisms across invocations.
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
  
  // We must instantiate temporarily just to read the default region
  // if region is undefined, because it is an instance property.
  const tempAdapter = new AdapterCtor();
  const resolvedRegion = normalizeRegion(region, tempAdapter.config.defaultRegion);
  
  const cacheKey = `${name}:${environment}:${resolvedRegion}`;
  if (adapterCache.has(cacheKey)) {
    return adapterCache.get(cacheKey)!;
  }
  
  const adapter = tempAdapter;
  if (adapter.setRegion) {
    adapter.setRegion(resolvedRegion);
  }
  if (adapter.setEnvironment) {
    adapter.setEnvironment(environment);
  }
  
  adapterCache.set(cacheKey, adapter);
  return adapter;
}

export function getSupportedExchangeNames(): ExchangeName[] {
  return Object.keys(adapterConstructors) as ExchangeName[];
}
