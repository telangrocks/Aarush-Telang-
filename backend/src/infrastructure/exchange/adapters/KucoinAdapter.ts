import { BaseExchangeAdapter } from './BaseExchangeAdapter';
import { ProviderConfig } from '../../../exchanges/models/ConnectionConfig';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade } from '../../../exchanges/models/NormalizedDomain';
import { ExchangeCapabilities } from '../../../domain/capabilities/ExchangeCapabilities';
import { WebCryptoSigner } from '../../crypto/WebCryptoSigner';
import { UnifiedError } from '../../../exchanges/models/UnifiedError';
import { ExchangeErrorClassifier } from '../../../exchanges/ExchangeErrorClassifier';
import { CandleValidator } from '../CandleValidator';
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
    const env = (config?.environment || '').toString().toLowerCase();
    if (env === 'testnet' || env === 'testing' || env === 'sandbox') {
      throw new UnifiedError('KuCoin Sandbox is officially deprecated and offline.', 'UNSUPPORTED_OPERATION');
    }
    await super.connect(config);
  }

  public override normalizeSymbol(symbol: string): { base: string; quote: string; canonicalSymbol: string } {
    if (!symbol) return { base: '', quote: '', canonicalSymbol: '' };
    const clean = symbol.trim().toUpperCase().replace(/[/]/g, '-');
    if (clean.includes('-')) {
      const [base, quote] = clean.split('-');
      return { base, quote, canonicalSymbol: `${base}/${quote}` };
    }
    return super.normalizeSymbolBase(symbol);
  }

  public normalizeInterval(interval: string): string {
    const kcMap: Record<string, string> = {
      '1m': '1min',
      '3m': '3min',
      '5m': '5min',
      '15m': '15min',
      '30m': '30min',
      '1h': '1hour',
      '2h': '2hour',
      '4h': '4hour',
      '6h': '6hour',
      '8h': '8hour',
      '12h': '12hour',
      '1d': '1day',
      '1w': '1week',
    };
    const mapped = kcMap[interval];
    if (!mapped) {
      throw new UnifiedError(`Unsupported interval: ${interval}`, 'UNSUPPORTED_OPERATION');
    }
    return mapped;
  }

  private async makeSignedRequest(method: 'GET' | 'POST' | 'DELETE', endpoint: string, bodyObj?: Record<string, any>): Promise<any> {
    const startTime = Date.now();
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
    let status = 0;
    try {
      const res = await this.fetchWithTimeout(url, {
        method,
        headers,
        body: bodyObj ? bodyStr : undefined,
      });

      status = res.status;
      const errText = await res.text();

      this.logger.logExchangeRequest({
        exchange: this.exchangeId,
        endpoint,
        requestUrl: url,
        latencyMs: Date.now() - startTime,
        status: status,
      });

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
    } catch (err: any) {
      if (!(err instanceof UnifiedError)) {
        this.logger.logExchangeRequest({
          exchange: this.exchangeId,
          endpoint,
          requestUrl: url,
          latencyMs: Date.now() - startTime,
          status: status || 500,
          failures: 1,
        });
      }
      throw err;
    }
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
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '-').toUpperCase();
    const url = `https://openapi-v2.kucoin.com/api/v1/market/stats?symbol=${rawSymbol}`;
    const startTime = Date.now();

    const res = await this.fetchWithTimeout(url, {
      headers: { 'User-Agent': 'CryptoPulse/1.0' },
    });

    this.logger.logExchangeRequest({
      exchange: this.exchangeId,
      endpoint: '/api/v1/market/stats',
      requestUrl: url,
      symbol: canonicalSymbol,
      latencyMs: Date.now() - startTime,
      status: res.status,
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

    const data = json.data;
    const px = new BigNumber(data.last || data.buy || data.sell || 0);

    return {
      symbol: canonicalSymbol,
      timestamp: data.time || Date.now(),
      last: px,
      bid: new BigNumber(data.buy || px.toString()),
      ask: new BigNumber(data.sell || px.toString()),
      high: new BigNumber(data.high || px.toString()),
      low: new BigNumber(data.low || px.toString()),
      volume: new BigNumber(data.vol || 0),
      quoteVolume: new BigNumber(data.volValue || 0),
    };
  }

  public async fetchKlines(symbol: string, interval: string, limit = 200): Promise<any[]> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '-').toUpperCase();
    const kcType = this.normalizeInterval(interval);
    const tfMs = CandleValidator.timeframeToMs(interval);

    const url = `https://openapi-v2.kucoin.com/api/v1/market/candles?symbol=${rawSymbol}&type=${kcType}`;
    const startTime = Date.now();

    const res = await this.fetchWithTimeout(url, {
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

    this.logger.logExchangeRequest({
      exchange: this.exchangeId,
      endpoint: '/api/v1/market/candles',
      requestUrl: url,
      symbol: canonicalSymbol,
      timeframe: interval,
      latencyMs: Date.now() - startTime,
      status: res.status,
      candleCount: Math.min(json.data.length, limit),
    });

    // KuCoin returns [time, open, close, high, low, volume, amount] descending
    const parsed = json.data.slice(0, limit).map((k: any) => {
      const openTime = parseInt(k[0], 10) * 1000;
      return {
        openTime,
        open: parseFloat(k[1]),
        close: parseFloat(k[2]),
        high: parseFloat(k[3]),
        low: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: openTime + tfMs - 1,
      };
    });

    // Sort ascending by openTime
    return parsed.sort((a: any, b: any) => a.openTime - b.openTime);
  }

  public async fetchMarkets(): Promise<Market[]> {
    const url = `https://openapi-v2.kucoin.com/api/v1/symbols`;
    const startTime = Date.now();

    const res = await this.fetchWithTimeout(url, {
      headers: { 'User-Agent': 'CryptoPulse/1.0' },
    });

    this.logger.logExchangeRequest({
      exchange: this.exchangeId,
      endpoint: '/api/v1/symbols',
      requestUrl: url,
      latencyMs: Date.now() - startTime,
      status: res.status,
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
    const { canonicalSymbol } = this.normalizeSymbol(order.symbol);
    const rawSymbol = canonicalSymbol.replace('/', '-').toUpperCase();
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
      symbol: canonicalSymbol,
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
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const data = await this.makeSignedRequest('GET', `/api/v1/orders/${orderId}`);
    return {
      id: data.id,
      clientOrderId: data.clientOid,
      symbol: canonicalSymbol,
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
    const rawSymbol = symbol ? this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '-').toUpperCase() : undefined;
    const endpoint = `/api/v1/orders?status=active${rawSymbol ? `&symbol=${rawSymbol}` : ''}`;
    const data = await this.makeSignedRequest('GET', endpoint);

    return (data?.items || []).map((item: any) => ({
      id: item.id,
      clientOrderId: item.clientOid,
      symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
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
    const rawSymbol = symbol ? this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '-').toUpperCase() : undefined;
    const endpoint = `/api/v1/orders?status=done${rawSymbol ? `&symbol=${rawSymbol}` : ''}`;
    const data = await this.makeSignedRequest('GET', endpoint);

    return (data?.items || []).map((item: any) => ({
      id: item.id,
      clientOrderId: item.clientOid,
      symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
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
    const rawSymbol = symbol ? this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '-').toUpperCase() : undefined;
    const endpoint = `/api/v1/fills${rawSymbol ? `?symbol=${rawSymbol}` : ''}`;
    const data = await this.makeSignedRequest('GET', endpoint);

    return (data?.items || []).map((item: any) => ({
      id: item.tradeId,
      orderId: item.orderId,
      symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
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
