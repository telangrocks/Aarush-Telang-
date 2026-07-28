import ccxt, { Exchange } from 'ccxt';
import type { Order as CcxtOrder } from 'ccxt';
import BigNumber from 'bignumber.js';
import { IExchangeProvider } from './IExchangeProvider';
import { ProviderConfig } from './models/ConnectionConfig';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade } from './models/NormalizedDomain';
import { UnifiedError } from './models/UnifiedError';

export class CcxtProvider implements IExchangeProvider {
  private exchangeId: string;
  private exchange: Exchange | null = null;
  private marketsCached: boolean = false;

  constructor(exchangeId: string) {
    this.exchangeId = exchangeId;
  }

  public async connect(config: ProviderConfig): Promise<void> {
    if (!ccxt.pro[this.exchangeId as keyof typeof ccxt.pro] && !ccxt[this.exchangeId as keyof typeof ccxt]) {
      throw new UnifiedError(`Exchange ${this.exchangeId} not supported by CCXT`, 'UNSUPPORTED_EXCHANGE');
    }

    const ExchangeClass = (ccxt as any)[this.exchangeId];
    
    const exchangeOptions: any = { enableRateLimit: true };
    if (config.apiKey) exchangeOptions.apiKey = config.apiKey;
    if (config.secret) exchangeOptions.secret = config.secret;
    if (config.password) exchangeOptions.password = config.password;
    
    this.exchange = new ExchangeClass(exchangeOptions) as Exchange;

    // Apply environment
    if (config.environment === 'Testing') {
      if (this.exchange.has['sandbox'] || this.exchange.urls.test) {
        this.exchange.setSandboxMode(true);
      } else {
        // Fallback or explicit mapping for exchanges that don't natively define test URLs in CCXT
        if (this.exchangeId === 'kucoin') {
          // KuCoin has permanently disabled their sandbox environment.
          throw new UnifiedError('KuCoin Sandbox is officially deprecated and offline.', 'UNSUPPORTED_OPERATION');
        }
      }
    } else {
      // Configuration Override: KuCoin Cloudflare WAF bypass
      // By default, CCXT targets api.kucoin.com. Cloudflare Workers and serverless 
      // edge environments are frequently blocked by KuCoin's Cloudflare WAF configuration.
      // This provider-level patch forces traffic through KuCoin's enterprise server-to-server 
      // gateway (openapi-v2), which is designed for programmatic access and bypasses the WAF.
      if (this.exchangeId === 'kucoin') {
        const prodUrl = 'https://openapi-v2.kucoin.com';
        for (const key of Object.keys(this.exchange.urls.api)) {
          if ((this.exchange.urls.api as any)[key] === 'https://api.kucoin.com') {
             (this.exchange.urls.api as any)[key] = prodUrl;
          }
        }
      }
    }

    // Load markets & cache (public — no credentials required)
    try {
      await this.exchange.loadMarkets();
      this.marketsCached = true;
    } catch (e: any) {
      throw this.mapError(e, 'loadMarkets');
    }

    // Authenticated connectivity check — only run when credentials are present.
    // Public/read-only providers (ticker, klines, markets) do not require auth.
    if (config.apiKey && config.secret) {
      try {
        await this.exchange.fetchBalance();
      } catch (e: any) {
        throw this.mapError(e, 'fetchBalance (Authentication Check)');
      }
    }
  }

  public async disconnect(): Promise<void> {
    this.exchange = null;
    this.marketsCached = false;
  }

  public async fetchMarkets(): Promise<Market[]> {
    this.ensureConnected();
    const markets = await this.exchange!.fetchMarkets();
    return markets.filter(m => !!m).map(m => ({
      id: m.id || '',
      symbol: m.symbol || '',
      base: m.base || '',
      quote: m.quote || '',
      active: m.active ?? true,
      precision: {
        price: this.exchange!.safeNumber(m.precision, 'price', 8) || 8,
        amount: this.exchange!.safeNumber(m.precision, 'amount', 8) || 8,
      },
      limits: {
        amount: {
          min: new BigNumber(m.limits?.amount?.min ?? 0),
          max: m.limits?.amount?.max ? new BigNumber(m.limits.amount.max) : undefined,
        },
        price: {
          min: new BigNumber(m.limits?.price?.min ?? 0),
          max: m.limits?.price?.max ? new BigNumber(m.limits.price.max) : undefined,
        },
        cost: {
          min: new BigNumber(m.limits?.cost?.min ?? 0),
          max: m.limits?.cost?.max ? new BigNumber(m.limits.cost.max) : undefined,
        }
      }
    }));
  }

  public async fetchBalance(): Promise<Balance[]> {
    this.ensureConnected();
    try {
      const balance = await this.exchange!.fetchBalance();
      const results: Balance[] = [];
      for (const currency of Object.keys(balance.total || {})) {
        if ((balance.total as any)[currency] && (balance.total as any)[currency]! > 0) {
          results.push({
            currency,
            free: new BigNumber((balance as any).free?.[currency] ?? 0),
            used: new BigNumber((balance as any).used?.[currency] ?? 0),
            total: new BigNumber((balance as any).total?.[currency] ?? 0),
          });
        }
      }
      return results;
    } catch (e: any) {
      throw this.mapError(e, 'fetchBalance');
    }
  }

  public async fetchTicker(symbol: string): Promise<Ticker> {
    this.ensureConnected();
    try {
      const ticker = await this.exchange!.fetchTicker(symbol);
      return {
        symbol: ticker.symbol || '',
        timestamp: ticker.timestamp ?? Date.now(),
        last: new BigNumber(ticker.last ?? 0),
        bid: new BigNumber(ticker.bid ?? 0),
        ask: new BigNumber(ticker.ask ?? 0),
        high: new BigNumber(ticker.high ?? 0),
        low: new BigNumber(ticker.low ?? 0),
        volume: new BigNumber(ticker.baseVolume ?? (ticker as any).volume ?? 0),
        quoteVolume: new BigNumber(ticker.quoteVolume ?? 0),
      };
    } catch (e: any) {
      throw this.mapError(e, 'fetchTicker');
    }
  }

  public async fetchKlines(symbol: string, interval: string, limit: number): Promise<any[]> {
    this.ensureConnected();
    try {
      const ohlcv = await this.exchange!.fetchOHLCV(symbol, interval, undefined, limit);
      return ohlcv.map(k => ({
        openTime: k[0],
        open: k[1],
        high: k[2],
        low: k[3],
        close: k[4],
        volume: k[5],
      }));
    } catch (e: any) {
      throw this.mapError(e, 'fetchKlines');
    }
  }

  public async fetchPositions(): Promise<Position[]> {
    this.ensureConnected();
    if (!this.exchange!.has['fetchPositions']) {
      throw new UnifiedError('fetchPositions not supported', 'UNSUPPORTED_OPERATION');
    }
    try {
      const positions = await this.exchange!.fetchPositions();
      return positions.map(p => ({
        symbol: p.symbol || '',
        size: new BigNumber(p.contracts ?? p.info.size ?? 0),
        side: p.side as 'long' | 'short',
        entryPrice: new BigNumber(p.entryPrice ?? 0),
        unrealizedPnl: new BigNumber(p.unrealizedPnl ?? 0),
        leverage: p.leverage ?? 1,
      }));
    } catch (e: any) {
      throw this.mapError(e, 'fetchPositions');
    }
  }

  public async createOrder(order: OrderRequest): Promise<Order> {
    this.ensureConnected();
    try {
      const response = await this.exchange!.createOrder(
        order.symbol,
        order.type,
        order.side,
        order.amount.toNumber(),
        order.price ? order.price.toNumber() : undefined,
        {
          clientOrderId: order.clientOrderId,
          timeInForce: order.timeInForce,
          ...order.params
        }
      );
      return this.mapOrder(response as CcxtOrder);
    } catch (e: any) {
      throw this.mapError(e, 'createOrder');
    }
  }

  public async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    this.ensureConnected();
    try {
      await this.exchange!.cancelOrder(orderId, symbol);
      return true;
    } catch (e: any) {
      throw this.mapError(e, 'cancelOrder');
    }
  }

  public async fetchOrder(orderId: string, symbol: string): Promise<Order> {
    this.ensureConnected();
    try {
      const response = await this.exchange!.fetchOrder(orderId, symbol);
      return this.mapOrder(response);
    } catch (e: any) {
      throw this.mapError(e, 'fetchOrder');
    }
  }

  public async fetchOpenOrders(symbol?: string): Promise<Order[]> {
    this.ensureConnected();
    try {
      const response = await this.exchange!.fetchOpenOrders(symbol);
      return response.map(o => this.mapOrder(o));
    } catch (e: any) {
      throw this.mapError(e, 'fetchOpenOrders');
    }
  }

  public async fetchClosedOrders(symbol?: string): Promise<Order[]> {
    this.ensureConnected();
    try {
      const response = await this.exchange!.fetchClosedOrders(symbol);
      return response.map(o => this.mapOrder(o));
    } catch (e: any) {
      throw this.mapError(e, 'fetchClosedOrders');
    }
  }

  public async fetchMyTrades(symbol?: string): Promise<Trade[]> {
    this.ensureConnected();
    try {
      const trades = await this.exchange!.fetchMyTrades(symbol);
      return trades.map(t => ({
        id: t.id || '',
        orderId: t.order || '',
        symbol: t.symbol || '',
        timestamp: t.timestamp ?? Date.now(),
        side: t.side as 'buy' | 'sell',
        price: new BigNumber(t.price ?? 0),
        amount: new BigNumber(t.amount ?? 0),
        cost: new BigNumber(t.cost ?? 0),
        fee: t.fee ? {
          currency: t.fee.currency || '',
          cost: new BigNumber(t.fee.cost ?? 0),
        } : undefined
      }));
    } catch (e: any) {
      throw this.mapError(e, 'fetchMyTrades');
    }
  }

  private ensureConnected(): void {
    if (!this.exchange || !this.marketsCached) {
      throw new UnifiedError('Exchange provider not connected', 'NOT_CONNECTED');
    }
  }

  private mapOrder(o: CcxtOrder): Order {
    return {
      id: o.id || '',
      clientOrderId: o.clientOrderId || '',
      symbol: o.symbol || '',
      timestamp: o.timestamp ?? Date.now(),
      status: o.status as 'open' | 'closed' | 'canceled' | 'rejected' | 'expired',
      side: o.side as 'buy' | 'sell',
      type: o.type as 'limit' | 'market',
      timeInForce: (o.timeInForce as any) ?? 'GTC',
      price: o.price ? new BigNumber(o.price) : undefined,
      average: o.average ? new BigNumber(o.average) : undefined,
      amount: new BigNumber(o.amount ?? 0),
      filled: new BigNumber(o.filled ?? 0),
      remaining: new BigNumber(o.remaining ?? 0),
      cost: new BigNumber(o.cost ?? 0),
      fee: o.fee ? {
        currency: o.fee.currency ?? '',
        cost: new BigNumber(o.fee.cost ?? 0)
      } : undefined
    };
  }

  private mapError(e: any, endpoint: string): UnifiedError {
    const errorClass = e.constructor.name;
    let mappedCode = 'UNKNOWN_ERROR';
    
    if (e instanceof ccxt.AuthenticationError) {
      mappedCode = 'AUTHENTICATION_FAILED';
    } else if (e instanceof ccxt.InsufficientFunds) {
      mappedCode = 'INSUFFICIENT_FUNDS';
    } else if (e instanceof ccxt.InvalidOrder) {
      mappedCode = 'INVALID_ORDER';
    } else if (e instanceof ccxt.RateLimitExceeded) {
      mappedCode = 'RATE_LIMIT_EXCEEDED';
    } else if (e instanceof ccxt.NetworkError) {
      mappedCode = 'NETWORK_ERROR';
    } else if (e instanceof ccxt.ExchangeNotAvailable) {
      mappedCode = 'EXCHANGE_NOT_AVAILABLE';
    } else if (e instanceof ccxt.NotSupported) {
      mappedCode = 'NOT_SUPPORTED';
    } else if (e instanceof ccxt.BadSymbol) {
      mappedCode = 'INVALID_SYMBOL';
    }

    return new UnifiedError(
      e.message,
      mappedCode,
      errorClass,
      e.code,
      e.message
    );
  }
}
