import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade } from '../../exchanges/models/NormalizedDomain';
import { ExchangeCapabilities } from '../../domain/capabilities/ExchangeCapabilities';
import { ProviderConfig } from '../../exchanges/models/ConnectionConfig';
import { Timeframe } from '../../engine/market-data/Timeframe';
import { NormalizedCandle } from '../../engine/market-data/MarketSnapshot';

export interface IExchangeAdapter {
  readonly exchangeId: string;
  readonly capabilities: ExchangeCapabilities;

  connect(config: ProviderConfig): Promise<void>;
  disconnect(): Promise<void>;

  fetchMarkets(): Promise<Market[]>;
  fetchBalance(): Promise<Balance[]>;
  fetchTicker(symbol: string): Promise<Ticker>;
  fetchKlines(symbol: string, interval: string, limit?: number): Promise<any[]>;
  fetchPositions(): Promise<Position[]>;

  createOrder(order: OrderRequest): Promise<Order>;
  cancelOrder(orderId: string, symbol: string): Promise<boolean>;
  fetchOrder(request: { clientOrderId?: string; exchangeOrderId?: string; symbol: string }): Promise<Order>;
  fetchOpenOrders(symbol?: string): Promise<Order[]>;
  fetchClosedOrders(symbol?: string): Promise<Order[]>;
  fetchMyTrades(symbol?: string): Promise<Trade[]>;
}

export interface ICandleProvider {
  fetchCandles(symbol: string, timeframe: Timeframe, limit?: number): Promise<NormalizedCandle[]>;
  fetchTicker(symbol: string): Promise<Ticker | null>;
}
