export type ExchangeName = "binance" | "delta" | "coinbase" | "kraken" | "bybit";

export interface ExchangeConfig {
  name: ExchangeName;
  displayName: string;
  restUrl: string;
}

export interface MarketTicker {
  symbol: string;
  price: number;
  volume24h: number;
  priceChange24h: number;
  priceChangePercent24h: number;
  highPrice24h: number;
  lowPrice24h: number;
  minNotional: number;
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
  { name: "coinbase", displayName: "Coinbase Advanced Trade", restUrl: "https://api.coinbase.com" },
  { name: "kraken", displayName: "Kraken", restUrl: "https://api.kraken.com" },
  { name: "bybit", displayName: "Bybit", restUrl: "https://api.bybit.com" },
];
