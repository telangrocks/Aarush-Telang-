import { type ValidationResult, type MarketTicker } from "./types";

export interface IExchangeAdapter {
  getName(): string;
  validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult>;
  fetchMarketData(): Promise<MarketTicker[]>;
}

export type { ValidationResult, MarketTicker } from "./types";
