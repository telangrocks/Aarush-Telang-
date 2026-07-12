import { IExchangeAdapter } from "./BaseExchange";
import { ExchangeName } from "./types";
import { BinanceExchange } from "./BinanceExchange";
import { DeltaExchange } from "./DeltaExchange";
import { CoinbaseExchange } from "./CoinbaseExchange";
import { KrakenExchange } from "./KrakenExchange";
import { BybitExchange } from "./BybitExchange";

const adapters: Record<ExchangeName, IExchangeAdapter> = {
  binance: new BinanceExchange(),
  delta: new DeltaExchange(),
  coinbase: new CoinbaseExchange(),
  kraken: new KrakenExchange(),
  bybit: new BybitExchange(),
};

export function getExchangeAdapter(name: ExchangeName): IExchangeAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(`Unsupported exchange: ${name}`);
  }
  return adapter;
}

export function getSupportedExchangeNames(): ExchangeName[] {
  return Object.keys(adapters) as ExchangeName[];
}
