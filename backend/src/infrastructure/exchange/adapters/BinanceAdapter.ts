import { BaseExchangeAdapter } from './BaseExchangeAdapter';
import { ProviderConfig } from '../../../exchanges/models/ConnectionConfig';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade } from '../../../exchanges/models/NormalizedDomain';
import { ExchangeCapabilities } from '../../../domain/capabilities/ExchangeCapabilities';
import { WebCryptoSigner } from '../../crypto/WebCryptoSigner';
import { UnifiedError } from '../../../exchanges/models/UnifiedError';
import { ExchangeErrorClassifier } from '../../../exchanges/ExchangeErrorClassifier';
import BigNumber from 'bignumber.js';

export class BinanceAdapter extends BaseExchangeAdapter {
  readonly exchangeId = 'binance';
  override readonly capabilities: ExchangeCapabilities = {
    version: { major: 1, minor: 0 },
    supportsOco: true,
    supportsSandbox: true,
    supportsMargin: false,
    supportsFutures: false,
    supportsTrailingStop: false,
    supportsMarketBuyRequiresPrice: true,
    supportsTimeSync: true,
    requiresPassphrase: false,
    supportsNativeProxy: true,
    advancedOrderTypes: {
      supportsTwap: false,
      supportsIceberg: false,
      supportsTrailingDelta: false,
      supportsSelfTradePrevention: false,
    },
  };

  private getHost(): string {
    const isTestnet = this.config?.environment === 'testnet' || this.config?.environment === 'Testing' || (this.config?.environment as string) === 'sandbox';
    if (isTestnet) {
      return (process.env.BINANCE_TESTNET_URL || 'https://testnet.binance.vision').replace(/\/$/, '');
    }
    return 'https://api.binance.com';
  }

  private async makeSignedRequest(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, any> = {}): Promise<any> {
    const cleanKey = (this.config?.apiKey || '').trim();
    const cleanSec = (this.config?.secret || '').trim();
    if (!cleanKey || !cleanSec) {
      throw new UnifiedError('Missing required exchange credentials (API Key or Secret).', 'MISSING_REQUIRED_CREDENTIALS');
    }

    const host = this.getHost();
    const ts = Date.now().toString();
    const queryParts = Object.keys(params)
      .filter(k => params[k] !== undefined && params[k] !== null)
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`);
    queryParts.push(`timestamp=${ts}`);
    queryParts.push(`recvWindow=10000`);

    const queryString = queryParts.join('&');
    const signature = await WebCryptoSigner.hmacSha256Hex(cleanSec, queryString);
    const url = `${host}${path}?${queryString}&signature=${signature}`;

    const res = await globalThis.fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': cleanKey,
        'Accept': 'application/json',
        'User-Agent': 'CryptoPulse/1.0',
      },
    });

    const errText = await res.text();
    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    try {
      return JSON.parse(errText);
    } catch (_) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }
  }

  public async fetchBalance(): Promise<Balance[]> {
    const data = await this.makeSignedRequest('GET', '/api/v3/account');
    const balances: Balance[] = [];
    if (Array.isArray(data?.balances)) {
      for (const b of data.balances) {
        const free = new BigNumber(b.free || 0);
        const locked = new BigNumber(b.locked || 0);
        balances.push({
          currency: b.asset,
          free,
          used: locked,
          total: free.plus(locked),
        });
      }
    }
    return balances;
  }

  public async fetchTicker(symbol: string): Promise<Ticker> {
    const rawSymbol = symbol.replace(/[/\s_-]/g, '').toUpperCase();
    const host = this.getHost();
    const url = `${host}/api/v3/ticker/24hr?symbol=${rawSymbol}`;

    const res = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'CryptoPulse/1.0' },
    });

    const errText = await res.text();
    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    let data: any = {};
    try {
      data = JSON.parse(errText);
    } catch (_) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    const px = new BigNumber(data.lastPrice || data.price || 0);
    return {
      symbol,
      timestamp: Date.now(),
      last: px,
      bid: new BigNumber(data.bidPrice || px.toString()),
      ask: new BigNumber(data.askPrice || px.toString()),
      high: new BigNumber(data.highPrice || px.toString()),
      low: new BigNumber(data.lowPrice || px.toString()),
      volume: new BigNumber(data.volume || 0),
      quoteVolume: new BigNumber(data.quoteVolume || 0),
    };
  }

  public async fetchKlines(symbol: string, interval: string, limit = 100): Promise<any[]> {
    const rawSymbol = symbol.replace(/[/\s_-]/g, '').toUpperCase();
    const host = this.getHost();
    const url = `${host}/api/v3/klines?symbol=${rawSymbol}&interval=${interval}&limit=${limit}`;

    const res = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'CryptoPulse/1.0' },
    });

    const errText = await res.text();
    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    let data: any[] = [];
    try {
      data = JSON.parse(errText);
    } catch (_) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    return data.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  public async fetchMarkets(): Promise<Market[]> {
    const host = this.getHost();
    const url = `${host}/api/v3/exchangeInfo`;

    const res = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'CryptoPulse/1.0' },
    });

    const errText = await res.text();
    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    let data: any = {};
    try {
      data = JSON.parse(errText);
    } catch (_) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    const markets: Market[] = [];
    if (Array.isArray(data.symbols)) {
      for (const s of data.symbols) {
        if (s.status !== 'TRADING') continue;
        const symbolStr = `${s.baseAsset}/${s.quoteAsset}`;
        let priceStep = 0.01;
        let amountStep = 0.0001;
        let minAmount = 0.0001;
        let minPrice = 0.01;
        let minNotional = 10;

        for (const filter of s.filters || []) {
          if (filter.filterType === 'PRICE_FILTER') {
            priceStep = parseFloat(filter.tickSize || '0.01');
            minPrice = parseFloat(filter.minPrice || '0.01');
          } else if (filter.filterType === 'LOT_SIZE') {
            amountStep = parseFloat(filter.stepSize || '0.0001');
            minAmount = parseFloat(filter.minQty || '0.0001');
          } else if (filter.filterType === 'NOTIONAL' || filter.filterType === 'MIN_NOTIONAL') {
            minNotional = parseFloat(filter.minNotional || filter.notional || '10');
          }
        }

        markets.push({
          id: s.symbol,
          symbol: symbolStr,
          base: s.baseAsset,
          quote: s.quoteAsset,
          active: s.status === 'TRADING',
          precision: { price: priceStep, amount: amountStep },
          limits: {
            amount: { min: new BigNumber(minAmount) },
            price: { min: new BigNumber(minPrice) },
            cost: { min: new BigNumber(minNotional) },
          },
        });
      }
    }
    return markets;
  }

  public async fetchPositions(): Promise<Position[]> {
    return [];
  }

  public async createOrder(order: OrderRequest): Promise<Order> {
    const rawSymbol = order.symbol.replace(/[/\s_-]/g, '').toUpperCase();
    const params: Record<string, any> = {
      symbol: rawSymbol,
      side: order.side.toUpperCase(),
      type: order.type.toUpperCase(),
      quantity: order.amount.toString(),
    };
    if (order.type.toUpperCase() === 'LIMIT') {
      params.price = order.price?.toString();
      params.timeInForce = 'GTC';
    }

    const data = await this.makeSignedRequest('POST', '/api/v3/order', params);
    return {
      id: String(data.orderId),
      clientOrderId: data.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status: data.status === 'FILLED' ? 'closed' : data.status === 'CANCELED' ? 'canceled' : 'open',
      price: new BigNumber(data.price || order.price || 0),
      amount: new BigNumber(data.origQty || order.amount),
      filled: new BigNumber(data.executedQty || 0),
      remaining: new BigNumber(data.origQty || order.amount).minus(new BigNumber(data.executedQty || 0)),
      timestamp: data.transactTime || Date.now(),
    };
  }

  public async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    const rawSymbol = symbol.replace(/[/\s_-]/g, '').toUpperCase();
    await this.makeSignedRequest('DELETE', '/api/v3/order', { symbol: rawSymbol, orderId });
    return true;
  }

  public async fetchOrder(orderId: string, symbol: string): Promise<Order> {
    const rawSymbol = symbol.replace(/[/\s_-]/g, '').toUpperCase();
    const data = await this.makeSignedRequest('GET', '/api/v3/order', { symbol: rawSymbol, orderId });
    return {
      id: String(data.orderId),
      clientOrderId: data.clientOrderId,
      symbol,
      side: data.side.toLowerCase() as 'buy' | 'sell',
      type: data.type.toLowerCase() as 'limit' | 'market',
      status: data.status === 'FILLED' ? 'closed' : data.status === 'CANCELED' ? 'canceled' : 'open',
      price: new BigNumber(data.price || 0),
      amount: new BigNumber(data.origQty || 0),
      filled: new BigNumber(data.executedQty || 0),
      remaining: new BigNumber(data.origQty || 0).minus(new BigNumber(data.executedQty || 0)),
      timestamp: data.time || Date.now(),
    };
  }

  public async fetchOpenOrders(symbol?: string): Promise<Order[]> {
    const params: Record<string, any> = {};
    if (symbol) params.symbol = symbol.replace(/[/\s_-]/g, '').toUpperCase();
    const data = await this.makeSignedRequest('GET', '/api/v3/openOrders', params);

    return (Array.isArray(data) ? data : []).map(item => ({
      id: String(item.orderId),
      clientOrderId: item.clientOrderId,
      symbol: item.symbol,
      side: item.side.toLowerCase() as 'buy' | 'sell',
      type: item.type.toLowerCase() as 'limit' | 'market',
      status: 'open',
      price: new BigNumber(item.price || 0),
      amount: new BigNumber(item.origQty || 0),
      filled: new BigNumber(item.executedQty || 0),
      remaining: new BigNumber(item.origQty || 0).minus(new BigNumber(item.executedQty || 0)),
      timestamp: item.time || Date.now(),
    }));
  }

  public async fetchClosedOrders(symbol?: string): Promise<Order[]> {
    const params: Record<string, any> = {};
    if (symbol) params.symbol = symbol.replace(/[/\s_-]/g, '').toUpperCase();
    const data = await this.makeSignedRequest('GET', '/api/v3/allOrders', params);

    return (Array.isArray(data) ? data : []).map(item => ({
      id: String(item.orderId),
      clientOrderId: item.clientOrderId,
      symbol: item.symbol,
      side: item.side.toLowerCase() as 'buy' | 'sell',
      type: item.type.toLowerCase() as 'limit' | 'market',
      status: item.status === 'FILLED' ? 'closed' : 'canceled',
      price: new BigNumber(item.price || 0),
      amount: new BigNumber(item.origQty || 0),
      filled: new BigNumber(item.executedQty || 0),
      remaining: new BigNumber(item.origQty || 0).minus(new BigNumber(item.executedQty || 0)),
      timestamp: item.time || Date.now(),
    }));
  }

  public async fetchMyTrades(symbol?: string): Promise<Trade[]> {
    const params: Record<string, any> = {};
    if (symbol) params.symbol = symbol.replace(/[/\s_-]/g, '').toUpperCase();
    const data = await this.makeSignedRequest('GET', '/api/v3/myTrades', params);

    return (Array.isArray(data) ? data : []).map(item => ({
      id: String(item.id),
      orderId: String(item.orderId),
      symbol: item.symbol,
      side: item.isBuyer ? 'buy' : 'sell',
      price: new BigNumber(item.price || 0),
      amount: new BigNumber(item.qty || 0),
      cost: new BigNumber(item.quoteQty || 0),
      fee: {
        cost: new BigNumber(item.commission || 0),
        currency: item.commissionAsset || 'USDT',
      },
      timestamp: item.time || Date.now(),
    }));
  }
}
