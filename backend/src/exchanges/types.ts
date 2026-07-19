export type ExchangeName = "binance" | "delta" | "bybit";

export type ExchangeEnvironment = "mainnet" | "testnet";

export interface SymbolMetadata {
  minQty: number;
  maxQty: number;
  tickSize: number;
  lotSize: number;
}

/**
 * Regional endpoint family. Delta Exchange operates separate, geo-fenced
 * deployments: the global `api.delta.exchange` (CloudFront-fronted) rejects
 * Indian traffic with a 403, while Indian accounts must use the dedicated
 * `api.india.delta.exchange` domain. Defaults to the safest value per
 * exchange in the adapter config.
 */
export type ExchangeRegion = "global" | "india";

export interface ExchangeConfig {
  name: ExchangeName;
  displayName: string;
  /** Default region when the client does not specify one. */
  defaultRegion: ExchangeRegion;
  environment?: ExchangeEnvironment;
  /** Base REST URL per region (keyed by ExchangeRegion). */
  regionUrls: Record<ExchangeRegion, string>;
  /** Optional testnet override per region. */
  regionTestnetUrls?: Partial<Record<ExchangeRegion, string>>;
}

export interface MarketTicker {
  symbol: string;
  price: number;
  volume24h: number;
  quoteVolume24h: number;
  priceChange24h: number;
  priceChangePercent24h: number;
  highPrice24h: number;
  lowPrice24h: number;
  minNotional: number;
  minOrderQty: number;
  maxOrderQty: number;
  tickSize: number;
  lotSize: number;
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface ValidationResult {
  success: boolean;
  message: string;
  /** Stable error code for user-friendly mapping (optional). */
  code?: string;
  /** Plain-language, actionable message safe to show the user (optional). */
  friendlyMessage?: string;
}

export const SUPPORTED_EXCHANGES: ExchangeConfig[] = [
  {
    name: "binance",
    displayName: "Binance",
    defaultRegion: "global",
    regionUrls: {
      global: "https://api.binance.com",
      india: "https://api.binance.com",
    },
  },
  {
    // Delta Exchange India accounts MUST use the India domain. The global
    // api.delta.exchange is geo-blocked (CloudFront 403) for Indian users.
    name: "delta",
    displayName: "Delta Exchange",
    defaultRegion: "india",
    regionUrls: {
      global: "https://api.delta.exchange",
      india: "https://api.india.delta.exchange",
    },
    regionTestnetUrls: {
      global: "https://api-testnet.delta.exchange",
      india: "https://cdn-ind.testnet.deltaex.org",
    },
  },
  {
    name: "bybit",
    displayName: "Bybit",
    defaultRegion: "global",
    regionUrls: {
      global: "https://api.bybit.com",
      india: "https://api.bybit.com",
    },
  },
];
