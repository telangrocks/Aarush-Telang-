import { type ValidationResult, type MarketTicker, type ExchangeConfig, type ExchangeName } from "./types";

export interface IExchangeAdapter {
  getName(): string;
  validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult>;
  fetchMarketData(): Promise<MarketTicker[]>;
}

export type { ValidationResult, MarketTicker, ExchangeConfig, ExchangeName } from "./types";
