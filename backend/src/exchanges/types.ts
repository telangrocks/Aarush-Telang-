export type ExchangeName = "binance" | "delta" | "bybit";

export type ExchangeEnvironment = "mainnet" | "testnet";

export interface ExchangeConfig {
  name: ExchangeName;
  displayName: string;
  restUrl: string;
  testnetUrl?: string;
  environment?: ExchangeEnvironment;
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
}

export const SUPPORTED_EXCHANGES: ExchangeConfig[] = [
  { name: "binance", displayName: "Binance", restUrl: "https://api.binance.com" },
  { name: "delta", displayName: "Delta Exchange", restUrl: "https://api.delta.exchange" },
  { name: "bybit", displayName: "Bybit", restUrl: "https://api.bybit.com" },
];
