import { BaseExchangeAdapter } from './BaseExchangeAdapter';
import { ProviderConfig } from '../../../exchanges/models/ConnectionConfig';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade } from '../../../exchanges/models/NormalizedDomain';
import { ExchangeCapabilities } from '../../../domain/capabilities/ExchangeCapabilities';
import { WebCryptoSigner } from '../../crypto/WebCryptoSigner';
import { UnifiedError } from '../../../exchanges/models/UnifiedError';
import { ExchangeErrorClassifier } from '../../../exchanges/ExchangeErrorClassifier';
import BigNumber from 'bignumber.js';

export class KucoinAdapter extends BaseExchangeAdapter {
  readonly exchangeId = 'kucoin';
  override readonly capabilities: ExchangeCapabilities = {
    version: { major: 1, minor: 0 },
    supportsOco: false,
    supportsSandbox: false, // KuCoin sandbox is deprecated
    supportsMargin: false,
    supportsFutures: false,
    supportsTrailingStop: false,
    supportsMarketBuyRequiresPrice: false,
    supportsTimeSync: true,
    requiresPassphrase: true,
    supportsNativeProxy: false,
    advancedOrderTypes: {
      supportsTwap: false,
      supportsIceberg: false,
      supportsTrailingDelta: false,
      supportsSelfTradePrevention: false,
    },
  };

  public override async connect(config: ProviderConfig): Promise<void> {
    if (config.environment === 'testnet' || config.environment === 'Testing' || config.environment === 'sandbox') {
      throw new UnifiedError('KuCoin Sandbox is officially deprecated and offline.', 'UNSUPPORTED_OPERATION');
    }
    await super.connect(config);
  }

  private async makeSignedRequest(method: 'GET' | 'POST' | 'DELETE', endpoint: string, bodyObj?: Record<string, any>): Promise<any> {
    const cleanKey = (this.config?.apiKey || '').trim();
    const cleanSec = (this.config?.secret || '').trim();
    const cleanPass = (this.config?.password || this.config?.passphrase || '').trim();

    if (!cleanKey || !cleanSec || !cleanPass) {
      throw new UnifiedError('Missing required KuCoin credentials (API Key, Secret, or Passphrase).', 'MISSING_REQUIRED_CREDENTIALS');
    }

    const ts = Date.now().toString();
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const passHmac = await WebCryptoSigner.hmacSha256Base64(cleanSec, cleanPass);
    const strToSign = ts + method + endpoint + bodyStr;
    const sig = await WebCryptoSigner.hmacSha256Base64(cleanSec, strToSign);

    const headers: Record<string, string> = {
      'KC-API-KEY': cleanKey,
      'KC-API-SIGN': sig,
      'KC-API-TIMESTAMP': ts,
      'KC-API-PASSPHRASE': passHmac,
      'KC-API-KEY-VERSION': '2',
      'Accept': 'application/json',
      'User-Agent': 'CryptoPulse/1.0',
    };

    if (bodyObj) {
      headers['Content-Type'] = 'application/json';
    }

    const url = `https://openapi-v2.kucoin.com${endpoint}`;
    const res = await globalThis.fetch(url, {
      method,
      headers,
      body: bodyObj ? bodyStr : undefined,
    });

    const errText = await res.text();
    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    let json: any = {};
    try {
      json = JSON.parse(errText);
    } catch (_) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    if (json.code !== '200000') {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage || json.msg, classified.code);
    }

    return json.data;
  }

  public async fetchBalance(): Promise<Balance[]> {
    const data = await this.makeSignedRequest('GET', '/api/v1/accounts?type=trade');
    const balances: Balance[] = [];
    if (Array.isArray(data)) {
      for (const b of data) {
        const free = new BigNumber(b.available || 0);
        const locked = new BigNumber(b.holds || 0);
        balances.push({
          currency: b.currency,
          free,
          used: locked,
          total: free.plus(locked),
        });
      }
    }
    return balances;
  }

  public async fetchTicker(symbol: string): Promise<Ticker> {
    const rawSymbol = symbol.replace('/', '-').toUpperCase();
    const url = `https://openapi-v2.kucoin.com/api/v1/market/orderbook/level1?symbol=${rawSymbol}`;
    const res = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'CryptoPulse/1.0' },
    });

    const errText = await res.text();
    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    let json: any = {};
    try {
      json = JSON.parse(errText);
    } catch (_) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    if (json.code !== '200000' || !json.data) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    const px = new BigNumber(json.data.price || json.data.bestBid || 0);
    return {
      symbol,
      timestamp: json.data.time || Date.now(),
      last: px,
      bid: new BigNumber(json.data.bestBid || px.toString()),
      ask: new BigNumber(json.data.bestAsk || px.toString()),
      high: px.multipliedBy(1.01),
      low: px.multipliedBy(0.99),
      volume: new BigNumber(json.data.size || 0),
      quoteVolume: px.multipliedBy(json.data.size || 0),
    };
  }

  public async fetchKlines(symbol: string, interval: string, limit = 100): Promise<any[]> {
    const rawSymbol = symbol.replace('/', '-').toUpperCase();
    const kcType = interval === '1m' ? '1min' : interval === '5m' ? '5min' : interval === '15m' ? '15min' : interval === '1h' ? '1hour' : '1min';
    const url = `https://openapi-v2.kucoin.com/api/v1/market/candles?symbol=${rawSymbol}&type=${kcType}`;

    const res = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'CryptoPulse/1.0' },
    });

    const errText = await res.text();
    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    let json: any = {};
    try {
      json = JSON.parse(errText);
    } catch (_) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    if (json.code !== '200000' || !Array.isArray(json.data)) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    return json.data.slice(0, limit).map((k: any) => ({
      openTime: parseInt(k[0], 10) * 1000,
      open: parseFloat(k[1]),
      close: parseFloat(k[2]),
      high: parseFloat(k[3]),
      low: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  public async fetchMarkets(): Promise<Market[]> {
    const url = `https://openapi-v2.kucoin.com/api/v1/symbols`;
    const res = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'CryptoPulse/1.0' },
    });

    const errText = await res.text();
    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    let json: any = {};
    try {
      json = JSON.parse(errText);
    } catch (_) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    const markets: Market[] = [];
    if (json.code === '200000' && Array.isArray(json.data)) {
      for (const item of json.data) {
        if (!item.enableTrading) continue;
        const symbolStr = `${item.baseCurrency}/${item.quoteCurrency}`;
        const priceStep = parseFloat(item.priceIncrement || '0.01');
        const amountStep = parseFloat(item.baseIncrement || '0.0001');
        const minAmount = parseFloat(item.baseMinSize || '0.0001');
        const minCost = parseFloat(item.minFunds || '10');

        markets.push({
          id: item.symbol,
          symbol: symbolStr,
          base: item.baseCurrency,
          quote: item.quoteCurrency,
          active: item.enableTrading,
          precision: { price: priceStep, amount: amountStep },
          limits: {
            amount: { min: new BigNumber(minAmount) },
            price: { min: new BigNumber(priceStep) },
            cost: { min: new BigNumber(minCost) },
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
    const rawSymbol = order.symbol.replace('/', '-').toUpperCase();
    const clientOid = crypto.randomUUID();
    const params = {
      clientOid,
      symbol: rawSymbol,
      side: order.side.toLowerCase(),
      type: order.type.toLowerCase(),
      size: order.amount.toString(),
      price: order.price ? order.price.toString() : undefined,
    };

    const data = await this.makeSignedRequest('POST', '/api/v1/orders', params);
    return {
      id: data.orderId,
      clientOrderId: clientOid,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status: 'open',
      price: order.price || new BigNumber(0),
      amount: order.amount,
      filled: new BigNumber(0),
      remaining: order.amount,
      timestamp: Date.now(),
    };
  }

  public async cancelOrder(orderId: string, _symbol: string): Promise<boolean> {
    await this.makeSignedRequest('DELETE', `/api/v1/orders/${orderId}`);
    return true;
  }

  public async fetchOrder(orderId: string, symbol: string): Promise<Order> {
    const data = await this.makeSignedRequest('GET', `/api/v1/orders/${orderId}`);
    return {
      id: data.id,
      clientOrderId: data.clientOid,
      symbol,
      side: data.side.toLowerCase() as 'buy' | 'sell',
      type: data.type.toLowerCase() as 'limit' | 'market',
      status: data.isActive ? 'open' : data.cancelExist ? 'canceled' : 'closed',
      price: new BigNumber(data.price || 0),
      amount: new BigNumber(data.size || 0),
      filled: new BigNumber(data.dealSize || 0),
      remaining: new BigNumber(data.size || 0).minus(new BigNumber(data.dealSize || 0)),
      timestamp: data.createdAt || Date.now(),
    };
  }

  public async fetchOpenOrders(symbol?: string): Promise<Order[]> {
    const rawSymbol = symbol ? symbol.replace('/', '-').toUpperCase() : undefined;
    const endpoint = `/api/v1/orders?status=active${rawSymbol ? `&symbol=${rawSymbol}` : ''}`;
    const data = await this.makeSignedRequest('GET', endpoint);

    return (data?.items || []).map((item: any) => ({
      id: item.id,
      clientOrderId: item.clientOid,
      symbol: item.symbol,
      side: item.side.toLowerCase() as 'buy' | 'sell',
      type: item.type.toLowerCase() as 'limit' | 'market',
      status: 'open',
      price: new BigNumber(item.price || 0),
      amount: new BigNumber(item.size || 0),
      filled: new BigNumber(item.dealSize || 0),
      remaining: new BigNumber(item.size || 0).minus(new BigNumber(item.dealSize || 0)),
      timestamp: item.createdAt || Date.now(),
    }));
  }

  public async fetchClosedOrders(symbol?: string): Promise<Order[]> {
    const rawSymbol = symbol ? symbol.replace('/', '-').toUpperCase() : undefined;
    const endpoint = `/api/v1/orders?status=done${rawSymbol ? `&symbol=${rawSymbol}` : ''}`;
    const data = await this.makeSignedRequest('GET', endpoint);

    return (data?.items || []).map((item: any) => ({
      id: item.id,
      clientOrderId: item.clientOid,
      symbol: item.symbol,
      side: item.side.toLowerCase() as 'buy' | 'sell',
      type: item.type.toLowerCase() as 'limit' | 'market',
      status: item.cancelExist ? 'canceled' : 'closed',
      price: new BigNumber(item.price || 0),
      amount: new BigNumber(item.size || 0),
      filled: new BigNumber(item.dealSize || 0),
      remaining: new BigNumber(item.size || 0).minus(new BigNumber(item.dealSize || 0)),
      timestamp: item.createdAt || Date.now(),
    }));
  }

  public async fetchMyTrades(symbol?: string): Promise<Trade[]> {
    const rawSymbol = symbol ? symbol.replace('/', '-').toUpperCase() : undefined;
    const endpoint = `/api/v1/fills${rawSymbol ? `?symbol=${rawSymbol}` : ''}`;
    const data = await this.makeSignedRequest('GET', endpoint);

    return (data?.items || []).map((item: any) => ({
      id: item.tradeId,
      orderId: item.orderId,
      symbol: item.symbol,
      side: item.side.toLowerCase() as 'buy' | 'sell',
      price: new BigNumber(item.price || 0),
      amount: new BigNumber(item.size || 0),
      cost: new BigNumber(item.funds || 0),
      fee: {
        cost: new BigNumber(item.fee || 0),
        currency: item.feeCurrency || 'USDT',
      },
      timestamp: item.createdAt || Date.now(),
    }));
  }
}
