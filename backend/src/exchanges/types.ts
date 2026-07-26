export type ExchangeName = "binance" | "delta" | "bybit";

export type ExchangeEnvironment = "mainnet" | "testnet";

export enum ValidationErrorReason {
  EXCHANGE_METADATA_UNAVAILABLE = "EXCHANGE_METADATA_UNAVAILABLE",
  INVALID_INPUT_PARAMETERS = "INVALID_INPUT_PARAMETERS",
  PRICE_BELOW_MINIMUM = "PRICE_BELOW_MINIMUM",
  PRICE_ABOVE_MAXIMUM = "PRICE_ABOVE_MAXIMUM",
  INVALID_TICK_SIZE = "INVALID_TICK_SIZE",
  MIN_QTY_FAILED = "MIN_QTY_FAILED",
  MAX_QTY_FAILED = "MAX_QTY_FAILED",
  INVALID_STEP_SIZE = "INVALID_STEP_SIZE",
  MIN_NOTIONAL_FAILED = "MIN_NOTIONAL_FAILED",
  MAX_POSITION_FAILED = "MAX_POSITION_FAILED",
  LEVERAGE_LIMIT_FAILED = "LEVERAGE_LIMIT_FAILED",
  EXCHANGE_RULES_UPDATED = "EXCHANGE_RULES_UPDATED",
}

export interface ExchangeFilterConstraint {
  filterType: string;
  parameters: Record<string, number | string | boolean>;
}

export interface SymbolTradingRules {
  schemaVersion: "2.0";
  symbol: string;
  exchange: string;
  baseAsset: string;
  quoteAsset: string;
  minNotional: number;
  minQty: number;
  maxQty: number;
  stepSize: number;
  tickSize: number;
  minPrice: number;
  maxPrice: number;
  contractSize: number;
  maxLeverage?: number;
  maxPosition?: number;
  additionalFilters?: ExchangeFilterConstraint[];
  lastUpdated: number;
}

export interface SymbolMetadata extends SymbolTradingRules {
  id?: string | number;
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

export interface ExchangeHealthMetrics {
  exchange: string;
  environment: string;
  region: string;
  authStatus: 'CONNECTED' | 'DISCONNECTED' | 'DEGRADED' | 'RATE_LIMITED';
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  currentEndpoint: string;
  timeOffsetMs: number;
  lastLatencyMs: number;
  wsStatus: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';
  wsReconnectCount: number;
  consecutiveFailures: number;
  circuitBreakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

export interface OperationalMetrics {
  exchange: string;
  authSuccessCount: number;
  authFailureCount: number;
  avgLatencyMs: number;
  wsUptimeSeconds: number;
  wsReconnectCount: number;
  retryCount: number;
  rateLimitHits: number;
  endpointFailovers: number;
  circuitBreakerTrips: number;
  lastErrorCode: string | null;
}

export interface ValidationResult {
  success: boolean;
  message: string;
  /** Stable error code for user-friendly mapping (optional). */
  code?: string;
  /** Plain-language, actionable message safe to show the user (optional). */
  friendlyMessage?: string;
  /** Actionable hint (e.g. IP whitelist) */
  hint?: string;
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
    regionTestnetUrls: {
      global: "https://testnet.binance.vision",
      india: "https://testnet.binance.vision",
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
    regionTestnetUrls: {
      global: "https://api-testnet.bybit.com",
      india: "https://api-testnet.bybit.com",
    },
  },
];
