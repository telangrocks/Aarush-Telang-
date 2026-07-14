import { type ValidationResult, type MarketTicker, type Kline, type ExchangeEnvironment } from "./types";

export interface OrderResult {
  success: boolean;
  message: string;
  orderId?: string;
  price?: number;
  quantity?: number;
}

export interface IExchangeAdapter {
  getName(): string;
  validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult>;
  fetchMarketData(): Promise<MarketTicker[]>;
  fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>;
  placeOrder?(symbol: string, side: 'BUY' | 'SELL', apiKey: string, apiSecret: string, quantity?: number): Promise<OrderResult>;
  setEnvironment?(environment: ExchangeEnvironment): void;
  getRestUrl(): string;
}

export type { ValidationResult, MarketTicker, Kline, ExchangeEnvironment } from "./types";
