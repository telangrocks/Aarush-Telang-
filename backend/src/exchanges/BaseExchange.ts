import { type ValidationResult, type MarketTicker, type Kline, type ExchangeEnvironment, type ExchangeRegion, type ExchangeConfig } from "./types";

export interface OrderResult {
  success: boolean;
  message: string;
  orderId?: string;
  exchangeOrderId?: string;
  tpOrderId?: string;
  slOrderId?: string;
  ocoGroupId?: string;
  protectionMode?: 'NATIVE_OCO' | 'ATTACHED_TPSL' | 'REDUCE_ONLY_TPSL' | 'SOFTWARE_FALLBACK';
  price?: number;
  quantity?: number;
  /** Stable error code for user-friendly mapping (optional). */
  code?: string;
  /** Plain-language, actionable message safe to show the user (optional). */
  friendlyMessage?: string;
  /** Actual filled quantity */
  filledQuantity?: number;
  /** Average fill price */
  averageFillPrice?: number;
  /** Order Status on Exchange */
  status?: 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired';
}

export interface PositionResult {
  symbol: string;
  size: number;
  entry_price: number;
  unrealized_pnl: number;
  margin?: number;
  side: 'BUY' | 'SELL';
}

export interface PositionsResponse {
  success: boolean;
  message: string;
  result: PositionResult[];
  code?: string;
  friendlyMessage?: string;
}

export interface IExchangeAdapter {
  readonly config: ExchangeConfig;
  getName(): string;
  validateCredentials(apiKey: string, apiSecret: string): Promise<ValidationResult>;
  fetchMarketData(): Promise<MarketTicker[]>;
  fetchTicker(symbol: string): Promise<MarketTicker | null>;
  fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>;
  placeOrder?(
    symbol: string,
    side: 'BUY' | 'SELL',
    apiKey: string,
    apiSecret: string,
    quantity?: number,
    clientOrderId?: string,
    orderType?: 'MARKET' | 'LIMIT',
    price?: number,
    stopLoss?: number,
    takeProfit?: number
  ): Promise<OrderResult>;
  placeOcoOrder?(
    symbol: string,
    side: 'BUY' | 'SELL',
    apiKey: string,
    apiSecret: string,
    quantity: number,
    takeProfitPrice: number,
    stopLossPrice: number,
    clientOrderId?: string
  ): Promise<OrderResult>;
  cancelOrder?(orderId: string, symbol: string, apiKey: string, apiSecret: string): Promise<{ success: boolean; message: string }>;
  fetchOrder?(orderId: string, apiKey: string, apiSecret: string): Promise<OrderResult>;
  fetchPositions?(apiKey: string, apiSecret: string): Promise<PositionsResponse>;
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
