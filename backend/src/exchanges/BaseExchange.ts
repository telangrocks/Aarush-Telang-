import { type ValidationResult, type MarketTicker } from "./types";

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
  placeOrder?(symbol: string, side: 'BUY' | 'SELL', apiKey: string, apiSecret: string, quantity?: number): Promise<OrderResult>;
}

export type { ValidationResult, MarketTicker } from "./types";
