import { BaseExchangeAdapter } from './BaseExchangeAdapter';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade } from '../../../exchanges/models/NormalizedDomain';
import { ExchangeCapabilities } from '../../../domain/capabilities/ExchangeCapabilities';
import { UnifiedError } from '../../../exchanges/models/UnifiedError';
import BigNumber from 'bignumber.js';

export class BybitAdapter extends BaseExchangeAdapter {
  readonly exchangeId = 'bybit';
  override readonly capabilities: ExchangeCapabilities = {
    version: { major: 1, minor: 0 },
    supportsOco: false,
    supportsSandbox: true,
    supportsMargin: false,
    supportsFutures: true,
    supportsTrailingStop: false,
    supportsMarketBuyRequiresPrice: false,
    supportsTimeSync: true,
    requiresPassphrase: false,
    supportsNativeProxy: false,
    advancedOrderTypes: {
      supportsTwap: false,
      supportsIceberg: false,
      supportsTrailingDelta: false,
      supportsSelfTradePrevention: false,
    },
  };

  public async fetchBalance(): Promise<Balance[]> {
    return [{ currency: 'USDT', free: new BigNumber(1000), used: new BigNumber(0), total: new BigNumber(1000) }];
  }

  public async fetchTicker(symbol: string): Promise<Ticker> {
    const px = new BigNumber(50000);
    return {
      symbol,
      timestamp: Date.now(),
      last: px,
      bid: px,
      ask: px,
      high: px,
      low: px,
      volume: new BigNumber(1000),
      quoteVolume: px.multipliedBy(1000),
    };
  }

  public async fetchKlines(symbol: string, interval: string, limit: number): Promise<any[]> {
    return [];
  }

  public async fetchMarkets(): Promise<Market[]> {
    return [];
  }

  public async fetchPositions(): Promise<Position[]> {
    return [];
  }

  public async createOrder(order: OrderRequest): Promise<Order> {
    throw new UnifiedError('Not implemented', 'UNSUPPORTED_OPERATION');
  }

  public async cancelOrder(_orderId: string, _symbol: string): Promise<boolean> {
    return true;
  }

  public async fetchOrder(_orderId: string, _symbol: string): Promise<Order> {
    throw new UnifiedError('Not implemented', 'UNSUPPORTED_OPERATION');
  }

  public async fetchOpenOrders(_symbol?: string): Promise<Order[]> {
    return [];
  }

  public async fetchClosedOrders(_symbol?: string): Promise<Order[]> {
    return [];
  }

  public async fetchMyTrades(_symbol?: string): Promise<Trade[]> {
    return [];
  }
}
