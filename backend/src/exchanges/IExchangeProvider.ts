import { ProviderConfig } from './models/ConnectionConfig';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade, OcoOrderRequest, OcoOrderResponse } from './models/NormalizedDomain';

export interface IExchangeProvider {
  connect(config: ProviderConfig): Promise<void>;
  disconnect(): Promise<void>;
  
  fetchMarkets(): Promise<Market[]>;
  fetchBalance(): Promise<Balance[]>;
  fetchTicker(symbol: string): Promise<Ticker>;
  fetchTickers(symbols?: string[]): Promise<Ticker[]>;
  fetchKlines(symbol: string, interval: string, limit: number): Promise<any[]>;
  fetchPositions(category?: string): Promise<Position[]>;
  
  createOrder(order: OrderRequest): Promise<Order>;
  cancelOrder(orderId: string, symbol: string, category?: string): Promise<boolean>;
  
  supportsOco(): boolean;
  createOcoOrder(order: OcoOrderRequest): Promise<OcoOrderResponse>;

  fetchOrder(request: { clientOrderId?: string; exchangeOrderId?: string; symbol: string; category?: string }): Promise<Order>;
  fetchOpenOrders(symbol?: string, category?: string): Promise<Order[]>;
  fetchClosedOrders(symbol?: string, category?: string): Promise<Order[]>;
  fetchMyTrades(symbol?: string, category?: string): Promise<Trade[]>;
}
