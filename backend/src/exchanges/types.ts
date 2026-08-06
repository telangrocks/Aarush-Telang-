export type ExchangeName = "binance" | "bybit" | "kucoin" | "delta";

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
  maxPosition?: number;
  additionalFilters?: ExchangeFilterConstraint[];
  lastUpdated: number;
}

export interface SymbolMetadata extends SymbolTradingRules {
  id?: string | number;
}

export enum BotState {
  NOT_STARTED = "NOT_STARTED",
  ACTIVATING = "ACTIVATING",
  INITIALISING_MARKET_DATA = "INITIALISING_MARKET_DATA",
  LOADING_STRATEGY = "LOADING_STRATEGY",
  LOADING_INDICATORS = "LOADING_INDICATORS",
  ANALYSING = "ANALYSING",
  WAITING_FOR_SIGNAL = "WAITING_FOR_SIGNAL",
  SIGNAL_GENERATED = "SIGNAL_GENERATED",
  TRADE_PENDING = "TRADE_PENDING",
  TRADE_EXECUTED = "TRADE_EXECUTED",
  MONITORING_POSITION = "MONITORING_POSITION",
  STOPPING = "STOPPING",
  STOPPED = "STOPPED",
}

export interface AnalysisSnapshot {
  schemaVersion: "2.0";
  sessionId: string;
  botState: BotState;
  symbol: string;
  exchange: string;
  strategy: string;
  timeframeStatus: Record<string, { interval: string; isLoaded: boolean; candleCount: number }>;
  indicators: {
    rsi: number;
    macd: { macd: number; signal: number; histogram: number };
    ema20: number;
    ema50: number;
    sma200: number;
    atr: number;
  };
  checkpoints: Array<{
    id: string;
    name: string;
    description: string;
    isMet: boolean;
    value: string;
    target: string;
  }>;
  confidence: number;
  decisionPipeline: {
    confluenceScore: number;
    alignment: "LONG" | "SHORT" | "NONE";
    primarySignal: "BUY" | "SELL" | "HOLD";
  };
  runtimeMetrics: {
    cycleNumber: number;
    uptimeSeconds: number;
    lastCompletedCycleMs: number;
    analysisDurationMs: number;
    exchangeLatencyMs: number;
    lastSuccessfulUpdate: string;
  };
  engineHealth: {
    status: "HEALTHY" | "DEGRADED" | "CRITICAL";
    activeSubscriptionsCount: number;
    errorsCount: number;
  };
  connectionHealth: {
    transportType: "POLLING" | "WEBSOCKET" | "SSE";
    isConnected: boolean;
    reconnectCount: number;
  };
  timestamp: string;
}

/**
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
    name: "kucoin",
    displayName: "KuCoin",
    defaultRegion: "global",
    regionUrls: {
      global: "https://openapi-v2.kucoin.com",
      india: "https://openapi-v2.kucoin.com",
    },
    regionTestnetUrls: {
      global: "https://openapi-sandbox.kucoin.com",
      india: "https://openapi-sandbox.kucoin.com",
    },
  },
  {
    name: "delta",
    displayName: "Delta Exchange",
    defaultRegion: "global",
    regionUrls: {
      global: "https://api.delta.exchange",
      india: "https://api.delta.exchange",
    },
    regionTestnetUrls: {
      global: "https://testnet-api.delta.exchange",
      india: "https://testnet-api.delta.exchange",
    },
  },
];
