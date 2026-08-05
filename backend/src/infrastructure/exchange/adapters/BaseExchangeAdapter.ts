import { IExchangeProvider } from '../../../exchanges/IExchangeProvider';
import { ProviderConfig } from '../../../exchanges/models/ConnectionConfig';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade, OcoOrderRequest, OcoOrderResponse } from '../../../exchanges/models/NormalizedDomain';
import { ExchangeCapabilities, DEFAULT_CAPABILITIES } from '../../../domain/capabilities/ExchangeCapabilities';
import { UnifiedError } from '../../../exchanges/models/UnifiedError';

export abstract class BaseExchangeAdapter implements IExchangeProvider {
  abstract readonly exchangeId: string;
  readonly capabilities: ExchangeCapabilities = DEFAULT_CAPABILITIES;
  protected config!: ProviderConfig;

  public async connect(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  public async disconnect(): Promise<void> {}

  abstract fetchMarkets(): Promise<Market[]>;
  abstract fetchBalance(): Promise<Balance[]>;
  abstract fetchTicker(symbol: string): Promise<Ticker>;
  abstract fetchKlines(symbol: string, interval: string, limit: number): Promise<any[]>;
  abstract fetchPositions(): Promise<Position[]>;

  abstract createOrder(order: OrderRequest): Promise<Order>;
  abstract cancelOrder(orderId: string, symbol: string): Promise<boolean>;

  public supportsOco(): boolean {
    return this.capabilities.supportsOco;
  }

  public async createOcoOrder(_order: OcoOrderRequest): Promise<OcoOrderResponse> {
    throw new UnifiedError(`OCO orders not supported on exchange ${this.exchangeId}`, 'UNSUPPORTED_OPERATION');
  }

  abstract fetchOrder(orderId: string, symbol: string): Promise<Order>;
  abstract fetchOpenOrders(symbol?: string): Promise<Order[]>;
  abstract fetchClosedOrders(symbol?: string): Promise<Order[]>;
  abstract fetchMyTrades(symbol?: string): Promise<Trade[]>;
}
