import { type ValidationResult, type MarketTicker, type Kline } from "./types";

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
}

export type { ValidationResult, MarketTicker, Kline } from "./types";
