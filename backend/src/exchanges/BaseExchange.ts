import { type ValidationResult, type MarketTicker, type Kline, type ExchangeEnvironment, type ExchangeRegion, type ExchangeConfig } from "./types";

export interface OrderResult {
  success: boolean;
  message: string;
  orderId?: string;
  price?: number;
  quantity?: number;
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
  if (lotSize <= 0) lotSize = 1;
  const rounded = Math.floor(quantity / lotSize) * lotSize;
  const min = Math.max(rounded, minQty);
  const max = Math.min(min, maxQty);
  return Math.max(max, 0);
}

export type { ValidationResult, MarketTicker, Kline, ExchangeEnvironment } from "./types";
