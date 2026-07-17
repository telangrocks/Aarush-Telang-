import { type ValidationResult, type MarketTicker, type Kline, type ExchangeEnvironment, type ExchangeRegion, type ExchangeConfig } from "./types";

export interface OrderResult {
  success: boolean;
  message: string;
  orderId?: string;
  price?: number;
  quantity?: number;
  /** Stable error code for user-friendly mapping (optional). */
  code?: string;
  /** Plain-language, actionable message safe to show the user (optional). */
  friendlyMessage?: string;
}

export interface IExchangeAdapter {
  readonly config: ExchangeConfig;
  getName(): string;
  validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult>;
  fetchMarketData(): Promise<MarketTicker[]>;
  fetchTicker(symbol: string): Promise<MarketTicker | null>;
  fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>;
  placeOrder?(symbol: string, side: 'BUY' | 'SELL', apiKey: string, apiSecret: string, quantity?: number): Promise<OrderResult>;
  setEnvironment?(environment: ExchangeEnvironment): void;
  setRegion?(region: ExchangeRegion): void;
  getRestUrl(): string;
}

export function normalizeQuantity(quantity: number, lotSize: number, minQty: number, maxQty: number): number {
  if (quantity <= 0) return 0;
  if (lotSize <= 0) lotSize = 1;
  
  // Calculate precision of the lot size step to avoid float rendering errors (e.g. 0.001 -> 3 decimals)
  const precision = lotSize > 0 && lotSize < 1 ? Math.round(-Math.log10(lotSize)) : 0;
  
  // Add a tiny epsilon (1e-10) to division to fix JS float division issues (e.g. 0.003 / 0.001 returning 2.9999999999999996)
  const rounded = Math.floor((quantity / lotSize) + 1e-10) * lotSize;
  const fixedRounded = parseFloat(rounded.toFixed(precision));
  
  const min = Math.max(fixedRounded, minQty);
  const max = Math.min(min, maxQty);
  return Math.max(max, 0);
}

export type { ValidationResult, MarketTicker, Kline, ExchangeEnvironment } from "./types";
