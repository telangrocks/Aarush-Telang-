import BigNumber from 'bignumber.js';

export interface Market {
  id: string;
  symbol: string;
  base: string;
  quote: string;
  category?: string;
  active: boolean;
  precision: {
    price: number;
    amount: number;
  };
  limits: {
    amount: { min: BigNumber; max?: BigNumber };
    price: { min: BigNumber; max?: BigNumber };
    cost: { min: BigNumber; max?: BigNumber };
  };
}

export interface Balance {
  currency: string;
  free: BigNumber;
  used: BigNumber;
  total: BigNumber;
}

export interface Ticker {
  symbol: string;
  timestamp: number;
  category?: string;
  last: BigNumber;
  bid: BigNumber;
  ask: BigNumber;
  high: BigNumber;
  low: BigNumber;
  volume: BigNumber;
  quoteVolume: BigNumber;
  change?: BigNumber;
  percentage?: number;
  info?: any;
}

export interface Position {
  symbol: string;
  size: BigNumber;
  side: 'long' | 'short';
  entryPrice: BigNumber;
  unrealizedPnl: BigNumber;
  markPrice?: BigNumber;
  leverage?: number;
  liquidationPrice?: BigNumber;
  stopLoss?: BigNumber;
  takeProfit?: BigNumber;
}

export interface Order {
  id: string;
  clientOrderId?: string;
  symbol: string;
  timestamp: number;
  status: 'open' | 'closed' | 'canceled' | 'rejected' | 'expired' | 'partially_filled';
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PO';
  price?: BigNumber;
  average?: BigNumber;
  amount: BigNumber;
  filled: BigNumber;
  remaining: BigNumber;
  cost?: BigNumber;
  fee?: {
    currency: string;
    cost: BigNumber;
  };
}

export interface Trade {
  id: string;
  orderId: string;
  symbol: string;
  timestamp: number;
  side: 'buy' | 'sell';
  price: BigNumber;
  amount: BigNumber;
  cost: BigNumber;
  fee?: {
    currency: string;
    cost: BigNumber;
  };
}

export interface OrderRequest {
  symbol: string;
  category?: string;
  type: 'limit' | 'market';
  side: 'buy' | 'sell';
  amount: BigNumber;
  price?: BigNumber;
  clientOrderId?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PO';
  params?: Record<string, any>;
}

export interface OcoOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  amount: BigNumber;
  price: BigNumber;           // Take profit price
  stopPrice: BigNumber;       // Stop loss trigger price
  stopLimitPrice?: BigNumber; // Stop loss limit execution price (defaults to stopPrice)
  clientOrderId?: string;
  listClientOrderId?: string;
  params?: Record<string, any>;
}

export interface OcoOrderResponse {
  ocoGroupId: string;
  symbol: string;
  status: string;
  tpOrderId?: string;
  slOrderId?: string;
  orders?: Order[];
  info?: any;
}
