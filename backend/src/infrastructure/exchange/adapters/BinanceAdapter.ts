import { BaseExchangeAdapter } from './BaseExchangeAdapter';
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

  public getHost(): string {
    return this.getHosts()[0];
  }

  public getHosts(): string[] {
    const isTestnet = this.config?.environment === 'testnet' || this.config?.environment === 'Testing' || (this.config?.environment as string) === 'sandbox';
    if (isTestnet) {
      return [(process.env.BINANCE_TESTNET_URL || 'https://testnet.binance.vision').replace(/\/$/, '')];
    }
    const envHost = process.env.BINANCE_BASE_URL ? [process.env.BINANCE_BASE_URL.replace(/\/$/, '')] : [];
    return Array.from(new Set([...envHost, 'https://api.binance.com', 'https://api.binance.us', 'https://testnet.binance.vision']));
  }

  private async makeSignedRequest(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, any> = {}): Promise<any> {
    const startTime = Date.now();
    const cleanKey = (this.config?.apiKey || '').replace(/[\u200B-\u200D\uFEFF]/g, "").trim().replace(/^["']|["']$/g, "").trim();
    const cleanSec = (this.config?.secret || '').replace(/[\u200B-\u200D\uFEFF]/g, "").trim().replace(/^["']|["']$/g, "").trim();
    if (!cleanKey || !cleanSec) {
      throw new UnifiedError('Missing required exchange credentials (API Key or Secret).', 'MISSING_REQUIRED_CREDENTIALS');
    }

    const ts = Date.now().toString();
    const queryParts = Object.keys(params)
      .filter(k => params[k] !== undefined && params[k] !== null)
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`);
    queryParts.push(`timestamp=${ts}`);
    queryParts.push(`recvWindow=10000`);

    const queryString = queryParts.join('&');
    const signature = await WebCryptoSigner.hmacSha256Hex(cleanSec, queryString);
    const fullPayload = `${queryString}&signature=${signature}`;

    const hosts = this.getHosts();
    let lastError: any;

    for (const host of hosts) {
      const url = `${host}${path}?${fullPayload}`;

      const headers: Record<string, string> = {
        'X-MBX-APIKEY': cleanKey,
        'Accept': 'application/json',
        'User-Agent': 'CryptoPulse/1.0',
      };

      let status = 0;
      try {
        const res = await this.fetchWithTimeout(url, {
          method,
          headers,
        });

        status = res.status;
        const errText = await res.text();

        if (status === 451 && host !== hosts[hosts.length - 1]) {
          this.logger.warn(`[BinanceAdapter] Regional restriction 451 on ${host}, trying fallback host...`);
          continue;
        }

        this.logger.logExchangeRequest({
          exchange: this.exchangeId,
          endpoint: path,
          requestUrl: url,
          symbol: params.symbol,
          latencyMs: Date.now() - startTime,
          status: status,
        });

        if (!res.ok) {
          console.error(`[BINANCE_API_ERROR] host=${host} path=${path} status=${res.status} body=${errText}`);
          const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
          throw new UnifiedError(classified.friendlyMessage, classified.code, res.status, errText);
        }

        try {
          return JSON.parse(errText);
        } catch (_) {
          const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
          throw new UnifiedError(classified.friendlyMessage, classified.code);
        }
      } catch (err: any) {
        lastError = err;
        if ((status === 451 || (err instanceof UnifiedError && err.code === 'REGION_NOT_SUPPORTED')) && host !== hosts[hosts.length - 1]) {
          continue;
        }
        if (!(err instanceof UnifiedError)) {
          this.logger.logExchangeRequest({
            exchange: this.exchangeId,
            endpoint: path,
            requestUrl: url,
            symbol: params.symbol,
            latencyMs: Date.now() - startTime,
            status: status || 500,
            failures: 1,
          });
        }
        throw err;
      }
    }
    throw lastError;
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
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const hosts = this.getHosts();
    let lastError: any;

    for (const host of hosts) {
      const url = `${host}/api/v3/ticker/24hr?symbol=${rawSymbol}`;
      const startTime = Date.now();

      try {
        const res = await this.fetchWithTimeout(url, {
          headers: { 'User-Agent': 'CryptoPulse/1.0' },
        });

        const errText = await res.text();

        if (res.status === 451 && host !== hosts[hosts.length - 1]) {
          this.logger.warn(`[BinanceAdapter] Regional restriction 451 on ${host}, trying fallback host...`);
          continue;
        }

        this.logger.logExchangeRequest({
          exchange: this.exchangeId,
          endpoint: '/api/v3/ticker/24hr',
          requestUrl: url,
          symbol: canonicalSymbol,
          latencyMs: Date.now() - startTime,
          status: res.status,
        });

        if (!res.ok) {
          const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
          if (classified.code === 'REGION_NOT_SUPPORTED' && host !== hosts[hosts.length - 1]) {
            continue;
          }
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
          symbol: canonicalSymbol,
          timestamp: Date.now(),
          last: px,
          bid: new BigNumber(data.bidPrice || px.toString()),
          ask: new BigNumber(data.askPrice || px.toString()),
          high: new BigNumber(data.highPrice || px.toString()),
          low: new BigNumber(data.lowPrice || px.toString()),
          volume: new BigNumber(data.volume || 0),
          quoteVolume: new BigNumber(data.quoteVolume || 0),
        };
      } catch (err: any) {
        lastError = err;
        if (err instanceof UnifiedError && err.code === 'REGION_NOT_SUPPORTED' && host !== hosts[hosts.length - 1]) {
          continue;
        }
        if (!(err instanceof UnifiedError)) {
          throw err;
        }
      }
    }
    throw lastError;
  }

  public async fetchKlines(symbol: string, interval: string, limit = 200): Promise<any[]> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const hosts = this.getHosts();
    let lastError: any;

    for (const host of hosts) {
      const url = `${host}/api/v3/klines?symbol=${rawSymbol}&interval=${interval}&limit=${limit}`;
      const startTime = Date.now();

      try {
        const res = await this.fetchWithTimeout(url, {
          headers: { 'User-Agent': 'CryptoPulse/1.0' },
        });

        const errText = await res.text();

        if (res.status === 451 && host !== hosts[hosts.length - 1]) {
          this.logger.warn(`[BinanceAdapter] Regional restriction 451 on ${host}, trying fallback host...`);
          continue;
        }

        if (!res.ok) {
          const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
          if (classified.code === 'REGION_NOT_SUPPORTED' && host !== hosts[hosts.length - 1]) {
            continue;
          }
          throw new UnifiedError(classified.friendlyMessage, classified.code);
        }

        let data: any[] = [];
        try {
          data = JSON.parse(errText);
        } catch (_) {
          const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
          throw new UnifiedError(classified.friendlyMessage, classified.code);
        }

        this.logger.logExchangeRequest({
          exchange: this.exchangeId,
          endpoint: '/api/v3/klines',
          requestUrl: url,
          symbol: canonicalSymbol,
          timeframe: interval,
          latencyMs: Date.now() - startTime,
          status: res.status,
          candleCount: data.length,
        });

        return data.map(k => ({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6],
        }));
      } catch (err: any) {
        lastError = err;
        if (err instanceof UnifiedError && err.code === 'REGION_NOT_SUPPORTED' && host !== hosts[hosts.length - 1]) {
          continue;
        }
        if (!(err instanceof UnifiedError)) {
          throw err;
        }
      }
    }
    throw lastError;
  }

  public async fetchMarkets(): Promise<Market[]> {
    const hosts = this.getHosts();
    let lastError: any;

    for (const host of hosts) {
      const url = `${host}/api/v3/exchangeInfo`;
      const startTime = Date.now();

      try {
        const res = await this.fetchWithTimeout(url, {
          headers: { 'User-Agent': 'CryptoPulse/1.0' },
        });

        const errText = await res.text();

        if (res.status === 451 && host !== hosts[hosts.length - 1]) {
          this.logger.warn(`[BinanceAdapter] Regional restriction 451 on ${host}, trying fallback host...`);
          continue;
        }

        this.logger.logExchangeRequest({
          exchange: this.exchangeId,
          endpoint: '/api/v3/exchangeInfo',
          requestUrl: url,
          latencyMs: Date.now() - startTime,
          status: res.status,
        });

        if (!res.ok) {
          const classified = ExchangeErrorClassifier.getInstance().classifyResponse('binance', res.status, res.headers, errText);
          if (classified.code === 'REGION_NOT_SUPPORTED' && host !== hosts[hosts.length - 1]) {
            continue;
          }
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
      } catch (err: any) {
        lastError = err;
        if (err instanceof UnifiedError && err.code === 'REGION_NOT_SUPPORTED' && host !== hosts[hosts.length - 1]) {
          continue;
        }
        if (!(err instanceof UnifiedError)) {
          throw err;
        }
      }
    }
    throw lastError;
  }

  public async fetchPositions(): Promise<Position[]> {
    return [];
  }

  public async createOrder(order: OrderRequest): Promise<Order> {
    const { canonicalSymbol } = this.normalizeSymbol(order.symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const params: Record<string, any> = {
      symbol: rawSymbol,
      side: order.side.toUpperCase(),
      type: order.type.toUpperCase(),
      quantity: order.amount.toString(),
    };
    if (order.clientOrderId) {
      const cleanId = order.clientOrderId.replace(/[^a-zA-Z0-9-_]/g, '');
      params.newClientOrderId = cleanId.length > 36 ? cleanId.slice(-36) : cleanId;
    }
    if (order.type.toUpperCase() === 'LIMIT') {
      params.price = order.price?.toString();
      params.timeInForce = 'GTC';
    }

    const data = await this.makeSignedRequest('POST', '/api/v3/order', params);
    return {
      id: String(data.orderId),
      clientOrderId: data.clientOrderId,
      symbol: canonicalSymbol,
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
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    await this.makeSignedRequest('DELETE', '/api/v3/order', { symbol: rawSymbol, orderId });
    return true;
  }

  public async fetchOrder(orderId: string, symbol: string): Promise<Order> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const data = await this.makeSignedRequest('GET', '/api/v3/order', { symbol: rawSymbol, orderId });
    return {
      id: String(data.orderId),
      clientOrderId: data.clientOrderId,
      symbol: canonicalSymbol,
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
    if (symbol) params.symbol = this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '').toUpperCase();
    const data = await this.makeSignedRequest('GET', '/api/v3/openOrders', params);

    return (Array.isArray(data) ? data : []).map(item => ({
      id: String(item.orderId),
      clientOrderId: item.clientOrderId,
      symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
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
    if (symbol) params.symbol = this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '').toUpperCase();
    const data = await this.makeSignedRequest('GET', '/api/v3/allOrders', params);

    return (Array.isArray(data) ? data : []).map(item => ({
      id: String(item.orderId),
      clientOrderId: item.clientOrderId,
      symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
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
    if (symbol) params.symbol = this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '').toUpperCase();
    const data = await this.makeSignedRequest('GET', '/api/v3/myTrades', params);

    return (Array.isArray(data) ? data : []).map(item => ({
      id: String(item.id),
      orderId: String(item.orderId),
      symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
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
