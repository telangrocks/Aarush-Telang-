import ccxt, { Exchange } from 'ccxt';
import type { Order as CcxtOrder } from 'ccxt';
import BigNumber from 'bignumber.js';
import { IExchangeProvider } from './IExchangeProvider';
import { ProviderConfig } from './models/ConnectionConfig';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade } from './models/NormalizedDomain';
import { UnifiedError } from './models/UnifiedError';
import { SymbolResolver } from '../utils/SymbolResolver';

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
    
    const exchangeOptions: any = {
      enableRateLimit: true,
      options: {
        recvWindow: 10000,
        adjustForTimeDifference: true,
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    };
    if (config.apiKey) exchangeOptions.apiKey = config.apiKey;
    if (config.secret) exchangeOptions.secret = config.secret;
    if (config.password) exchangeOptions.password = config.password;
    
    if (this.exchangeId === 'kucoin') {
      exchangeOptions.options = {
        ...exchangeOptions.options,
        loadAccountMode: false,
        defaultType: 'trade',
        accountType: 'trade',
      };
    }

    this.exchange = new ExchangeClass(exchangeOptions) as Exchange;

    if (this.exchangeId === 'kucoin') {
      if (!this.exchange.options) this.exchange.options = {};
      this.exchange.options['defaultType'] = 'trade';
      this.exchange.options['accountType'] = 'trade';
      this.exchange.options['loadAccountMode'] = false;
      (this.exchange.has as any)['fetchCurrencies'] = false;
      (this.exchange.has as any)['fetchTickers'] = false;
      (this.exchange.has as any)['fetchBidsAsks'] = false;
      (this.exchange as any).loadAccountMode = async () => ({});
      (this.exchange as any).fetchAccountMode = async () => ({});

      this.exchange.markets = { 'BTC/USDT': { id: 'BTC-USDT', symbol: 'BTC/USDT' } as any };
      this.exchange.markets_by_id = { 'BTC-USDT': { id: 'BTC-USDT', symbol: 'BTC/USDT' } as any };

      if (this.exchange.urls?.api && typeof this.exchange.urls.api === 'object') {
        const prodUrl = 'https://openapi-v2.kucoin.com';
        for (const key of Object.keys(this.exchange.urls.api)) {
          if (typeof (this.exchange.urls.api as any)[key] === 'string') {
            (this.exchange.urls.api as any)[key] = (this.exchange.urls.api as any)[key].replace('https://api.kucoin.com', prodUrl);
          }
        }
      }

      const origFetch = this.exchange.fetch.bind(this.exchange);
      const kuSecret = config.secret || this.exchange.secret || '';
      const kuApiKey = config.apiKey || this.exchange.apiKey || '';
      const kuPassword = config.password || this.exchange.password || '';

      this.exchange.fetch = async (url: string, method = 'GET', headers: any = {}, body?: any) => {
        if (typeof url === 'string' && url.includes('/api/v1/accounts')) {
          const ts = Date.now().toString();
          const endpoint = '/api/v1/accounts?type=trade';
          const encoder = new TextEncoder();
          const keyData = encoder.encode(kuSecret);
          const passData = encoder.encode(kuPassword);
          const key = await globalThis.crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const passSigBuf = await globalThis.crypto.subtle.sign('HMAC', key, passData);
          const passHmac = btoa(String.fromCharCode(...new Uint8Array(passSigBuf)));
          const strToSign = ts + method.toUpperCase() + endpoint;
          const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(strToSign));
          const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
          const cleanHeaders = {
            'KC-API-KEY': kuApiKey,
            'KC-API-SIGN': sig,
            'KC-API-TIMESTAMP': ts,
            'KC-API-PASSPHRASE': passHmac,
            'KC-API-KEY-VERSION': '2',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          };
          try {
            return await globalThis.fetch('https://openapi-v2.kucoin.com' + endpoint, { method, headers: cleanHeaders });
          } catch (fetchErr: any) {
            console.error('KUCOIN FETCH ERR:', fetchErr.message || String(fetchErr));
            throw fetchErr;
          }
        }
        const cleanHeaders = { ...headers };
        delete cleanHeaders['KC-API-PARTNER'];
        delete cleanHeaders['KC-API-PARTNER-SIGN'];
        delete cleanHeaders['KC-API-PARTNER-VERIFY'];
        if (typeof url === 'string') {
          if (url.includes('/margin/symbols') || url.includes('/isolated/symbols')) {
            return JSON.stringify({ code: '200000', data: [] });
          }
          if (url.includes('/api/v2/symbols')) {
            return origFetch(url.replace('/api/v2/symbols', '/api/v1/symbols'), method, cleanHeaders, body);
          }
        }
        return origFetch(url, method, cleanHeaders, body);
      };

      const origRequest = this.exchange.request.bind(this.exchange);
      this.exchange.request = async (path: any, api: any = 'public', method: any = 'GET', params: any = {}, headers: any = undefined, body: any = undefined, config: any = {}) => {
        const pathStr = String(path);
        if (pathStr.includes('account/mode')) {
          return { code: '200000', data: { mode: 1 } };
        }
        if (pathStr.includes('currencies')) {
          return { code: '200000', data: [] };
        }
        return origRequest(path, api, method, params, headers, body, config);
      };
    }

    // Apply environment
    if (config.environment === 'Testing' || config.environment === 'testnet') {
      if (this.exchange.has['sandbox'] || this.exchange.urls.test) {
        this.exchange.setSandboxMode(true);
      }
      if (this.exchangeId === 'binance' && this.exchange.urls) {
        (this.exchange as any).fetchCapitalConfig = async () => [];
        this.exchange.markets = { 'BTC/USDT': { id: 'BTCUSDT', symbol: 'BTC/USDT' } as any };
        this.exchange.markets_by_id = { 'BTCUSDT': { id: 'BTCUSDT', symbol: 'BTC/USDT' } as any };
        this.exchange.urls.api = {
          public: 'https://testnet.binance.vision/api/v3',
          private: 'https://testnet.binance.vision/api/v3',
          sapi: 'https://testnet.binance.vision/api/v3',
          wapi: 'https://testnet.binance.vision/api/v3',
          fapi: 'https://testnet.binancefuture.com/fapi/v1',
        };

        const secretVal = config.secret || this.exchange.secret || '';
        const apiKeyVal = config.apiKey || this.exchange.apiKey || '';
        const origFetch = this.exchange.fetch.bind(this.exchange);
        this.exchange.fetch = async (url: string, method = 'GET', headers: any = {}, body?: any) => {
          if (typeof url === 'string' && url.includes('/api/v3/account')) {
            const ts = Date.now();
            const query = 'timestamp=' + ts + '&recvWindow=10000';
            const encoder = new TextEncoder();
            const keyData = encoder.encode(secretVal);
            const msgData = encoder.encode(query);
            const key = await globalThis.crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, msgData);
            const sig = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
            const cleanUrl = 'https://testnet.binance.vision/api/v3/account?' + query + '&signature=' + sig;
            return globalThis.fetch(cleanUrl, { method: 'GET', headers: { 'X-MBX-APIKEY': apiKeyVal } });
          }
          return origFetch(url, method, headers, body);
        };
      } else if (this.exchangeId === 'kucoin') {
        // KuCoin has permanently disabled their sandbox environment.
        throw new UnifiedError('KuCoin Sandbox is officially deprecated and offline.', 'UNSUPPORTED_OPERATION');
      }
    }

    if (this.exchangeId === 'binance') {
      (this.exchange as any).fetchCapitalConfig = async () => [];
    }

    // Load markets & cache (public — no credentials required)
    try {
      if (this.exchangeId === 'kucoin' || this.exchangeId === 'delta' || (this.exchangeId === 'binance' && (config.environment === 'Testing' || config.environment === 'testnet'))) {
        this.marketsCached = true;
      } else {
        await this.exchange.loadMarkets();
        this.marketsCached = true;
      }
    } catch (e: any) {
      throw this.mapError(e, 'loadMarkets');
    }

    // Authenticated connectivity check — only run when credentials are present.
    // Public/read-only providers (ticker, klines, markets) do not require auth.
    if (config.apiKey && config.secret) {
      try {
        if (this.exchangeId === 'binance' && this.exchange.has['fetchTime']) {
          try {
            const serverTime = await this.exchange.fetchTime();
            if (typeof serverTime === 'number' && serverTime > 0) {
              const diff = serverTime - Date.now();
              (this.exchange as any).timeDifference = diff;
              if (!this.exchange.options) this.exchange.options = {};
              this.exchange.options['timeDifference'] = diff;
            }
          } catch (_) {}
        }
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

  private toCcxtSymbol(symbol: string): string {
    if (!symbol) return 'BTC/USDT';
    if (symbol.includes('/')) return symbol.toUpperCase();
    if (symbol.includes('-')) return symbol.replace('-', '/').toUpperCase();
    const res = SymbolResolver.resolve(symbol);
    return `${res.baseAsset}/${res.quoteAsset}`;
  }

  private ensureMarket(symbol: string): string {
    const ccxtSymbol = this.toCcxtSymbol(symbol);
    if (this.exchange) {
      if (!this.exchange.markets) this.exchange.markets = {};
      if (!this.exchange.markets_by_id) this.exchange.markets_by_id = {};
      if (!this.exchange.markets[ccxtSymbol]) {
        const [base, quote] = ccxtSymbol.split('/');
        const rawId = `${base}${quote}`;
        const marketObj = {
          id: rawId,
          symbol: ccxtSymbol,
          base,
          quote,
          active: true,
          spot: true,
          precision: { price: 8, amount: 8 },
          limits: {}
        };
        this.exchange.markets[ccxtSymbol] = marketObj as any;
        this.exchange.markets_by_id[rawId] = marketObj as any;
        if (Array.isArray((this.exchange as any).symbols)) {
          if (!(this.exchange as any).symbols.includes(ccxtSymbol)) {
            (this.exchange as any).symbols.push(ccxtSymbol);
          }
        }
      }
    }
    return ccxtSymbol;
  }

  public async fetchTicker(symbol: string): Promise<Ticker> {
    this.ensureConnected();
    const cleanSymbol = this.ensureMarket(symbol);
    try {
      const ticker = await this.exchange!.fetchTicker(cleanSymbol);
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
    const cleanSymbol = this.ensureMarket(symbol);
    try {
      const ohlcv = await this.exchange!.fetchOHLCV(cleanSymbol, interval, undefined, limit);
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
    const cleanSymbol = this.ensureMarket(order.symbol);
    try {
      const response = await this.exchange!.createOrder(
        cleanSymbol,
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
    const cleanSymbol = this.ensureMarket(symbol);
    try {
      await this.exchange!.cancelOrder(orderId, cleanSymbol);
      return true;
    } catch (e: any) {
      throw this.mapError(e, 'cancelOrder');
    }
  }

  public async fetchOrder(orderId: string, symbol: string): Promise<Order> {
    this.ensureConnected();
    const cleanSymbol = this.ensureMarket(symbol);
    try {
      const response = await this.exchange!.fetchOrder(orderId, cleanSymbol);
      return this.mapOrder(response);
    } catch (e: any) {
      throw this.mapError(e, 'fetchOrder');
    }
  }

  public async fetchOpenOrders(symbol?: string): Promise<Order[]> {
    this.ensureConnected();
    const cleanSymbol = symbol ? this.ensureMarket(symbol) : undefined;
    try {
      const response = await this.exchange!.fetchOpenOrders(cleanSymbol);
      return response.map(o => this.mapOrder(o));
    } catch (e: any) {
      throw this.mapError(e, 'fetchOpenOrders');
    }
  }

  public async fetchClosedOrders(symbol?: string): Promise<Order[]> {
    this.ensureConnected();
    const cleanSymbol = symbol ? this.ensureMarket(symbol) : undefined;
    try {
      const response = await this.exchange!.fetchClosedOrders(cleanSymbol);
      return response.map(o => this.mapOrder(o));
    } catch (e: any) {
      throw this.mapError(e, 'fetchClosedOrders');
    }
  }

  public async fetchMyTrades(symbol?: string): Promise<Trade[]> {
    this.ensureConnected();
    const cleanSymbol = symbol ? this.ensureMarket(symbol) : undefined;
    try {
      const trades = await this.exchange!.fetchMyTrades(cleanSymbol);
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
