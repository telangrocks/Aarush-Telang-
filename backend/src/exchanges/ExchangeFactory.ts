import { IExchangeAdapter } from "./BaseExchange";
import { ExchangeName, ExchangeEnvironment } from "./types";
import { BinanceExchange } from "./BinanceExchange";
import { DeltaExchange } from "./DeltaExchange";
import { CoinbaseExchange } from "./CoinbaseExchange";
import { KrakenExchange } from "./KrakenExchange";
import { BybitExchange } from "./BybitExchange";

// Map exchange names to their adapter constructors. A fresh adapter instance is
// created on every call to `getExchangeAdapter` so that request-scoped state
// (such as the selected mainnet/testnet environment) can never leak across
// concurrent requests belonging to different users. Adapters used to be shared
// singletons with mutable `environment` state, which caused a race condition
// where one request could clobber the environment of another in-flight request.
const adapterConstructors: Record<ExchangeName, new () => IExchangeAdapter> = {
  binance: BinanceExchange,
  delta: DeltaExchange,
  coinbase: CoinbaseExchange,
  kraken: KrakenExchange,
  bybit: BybitExchange,
};

/**
 * Resolve an exchange adapter for the given exchange, configured for the
 * requested environment (defaults to "mainnet"). Selecting "testnet" points the
 * adapter at the exchange's sandbox/testnet REST endpoint for BOTH credential
 * validation and all subsequent API calls.
 */
export function getExchangeAdapter(
  name: ExchangeName,
  environment: ExchangeEnvironment = "mainnet",
): IExchangeAdapter {
  const AdapterCtor = adapterConstructors[name];
  if (!AdapterCtor) {
    throw new Error(`Unsupported exchange: ${name}`);
  }
  const adapter = new AdapterCtor();
  if (adapter.setEnvironment) {
    adapter.setEnvironment(environment);
  }
  return adapter;
}

export function getSupportedExchangeNames(): ExchangeName[] {
  return Object.keys(adapterConstructors) as ExchangeName[];
}
