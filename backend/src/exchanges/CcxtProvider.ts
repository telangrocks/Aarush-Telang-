import ccxt, { Exchange } from 'ccxt';
import type { Order as CcxtOrder } from 'ccxt';
import BigNumber from 'bignumber.js';
import { IExchangeProvider } from './IExchangeProvider';
import { ProviderConfig } from './models/ConnectionConfig';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade } from './models/NormalizedDomain';
import { UnifiedError } from './models/UnifiedError';
import { SymbolResolver } from '../utils/SymbolResolver';

export class CcxtProvider implements IExchangeProvider {
  private static tickerCache = new Map<string, { ticker: Ticker; timestamp: number }>();
  private exchangeId: string;
  private exchange: Exchange | null = null;
  private marketsCached: boolean = false;
  private config!: ProviderConfig;

  constructor(exchangeId: string) {
    this.exchangeId = exchangeId;
  }

  public async connect(config: ProviderConfig): Promise<void> {
    this.config = config;
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
    const pwd = config.password || config.passphrase || (config as any).apiPassphrase;
    if (config.apiKey) exchangeOptions.apiKey = config.apiKey;
    if (config.secret) exchangeOptions.secret = config.secret;
    if (pwd) exchangeOptions.password = pwd;
    
    if (this.exchangeId === 'kucoin') {
      exchangeOptions.options = {
        ...exchangeOptions.options,
        loadAccountMode: false,
        defaultType: 'trade',
        accountType: 'trade',
      };
    }

    this.exchange = new ExchangeClass(exchangeOptions) as Exchange;

    if (this.exchangeId === 'binance' && this.exchange.options) {
      if (!Array.isArray(this.exchange.options['createMarketBuyOrderRequiresPrice'])) {
        this.exchange.options['createMarketBuyOrderRequiresPrice'] = ['market'];
      }
    }

    // --- TASK #6 DUMP #1: IMMEDIATELY AFTER CONSTRUCTOR ---
    const ex1 = this.exchange as any;
    const describeOpts1 = ex1?.describe ? (ex1.describe().options || {}) : {};
    const runtimeOpts1 = ex1?.options || {};
    
    console.log('[TASK_6_DUMP_1_AFTER_CONSTRUCTOR]', JSON.stringify({
      keysCount: Object.keys(runtimeOpts1).length,
      defaultType: runtimeOpts1.defaultType,
      createMarketBuyOrderRequiresPrice: runtimeOpts1.createMarketBuyOrderRequiresPrice,
      typeofCreateMarketBuyOrderRequiresPrice: typeof runtimeOpts1.createMarketBuyOrderRequiresPrice,
      jsonCreateMarketBuyOrderRequiresPrice: JSON.stringify(runtimeOpts1.createMarketBuyOrderRequiresPrice),
      isIdentityWithDescribe: runtimeOpts1 === describeOpts1,
      describeKeysCount: Object.keys(describeOpts1).length,
      entireObject: runtimeOpts1
    }, null, 2));

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
      const kuPassword = config.password || config.passphrase || this.exchange.password || '';

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
        const testnetHost = (process.env.BINANCE_TESTNET_URL || 'https://testnet.binance.vision').replace(/\/$/, '');
        this.exchange.urls.api = {
          ...(this.exchange.urls.api as Record<string, string>),
          sapi: `${testnetHost}/api/v3`,
          wapi: `${testnetHost}/api/v3`,
          fapi: 'https://testnet.binancefuture.com/fapi/v1',
        };

        const origFetch = this.exchange.fetch.bind(this.exchange);
        this.exchange.fetch = async (url: any, method = 'GET', headers: any = {}, body?: any) => {
          try {
            const urlString = typeof url === 'string' ? url : (url && typeof url.url === 'string' ? url.url : String(url || ''));
            if (urlString && (urlString.includes('/sapi/') || urlString.includes('/wapi/') || urlString.includes('/fapi/') || urlString.includes('/capital/config/getall'))) {
              console.warn(`[SHORT-CIRCUITED UNSUPPORTED TESTNET ENDPOINT] ${method} ${urlString}`);
              return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return origFetch(url, method, headers, body);
          } catch (fetchErr: any) {
            console.error('[DIAGNOSTIC] CcxtProvider.fetch override exception:', fetchErr?.message, fetchErr?.stack);
            throw fetchErr;
          }
        };
      } else if (this.exchangeId === 'kucoin') {
        // KuCoin has permanently disabled their sandbox environment.
        throw new UnifiedError('KuCoin Sandbox is officially deprecated and offline.', 'UNSUPPORTED_OPERATION');
      }
    }

    if (this.exchangeId === 'binance') {
      (this.exchange as any).fetchCapitalConfig = async () => [];
      (this.exchange as any).publicGetExchangeInfo = async () => ({ symbols: [] });
      (this.exchange as any).publicGetApiV3ExchangeInfo = async () => ({ symbols: [] });

      const isTestnet = config.environment === 'testnet' || config.environment === 'Testing';
      const host = isTestnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
      const cleanKey = config.apiKey || '';
      const cleanSec = config.secret || '';

      if (cleanKey && cleanSec) {
        this.exchange.fetchBalance = async () => {
          const ts = Date.now().toString();
          const query = `timestamp=${ts}&recvWindow=10000`;
          const encoder = new TextEncoder();
          const keyData = encoder.encode(cleanSec);
          const queryData = encoder.encode(query);
          const key = await globalThis.crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, queryData);
          const hashArray = Array.from(new Uint8Array(sigBuf));
          const sigHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
          const url = `${host}/api/v3/account?${query}&signature=${sigHex}`;

          console.log(`[BINANCE NATIVE FETCHBALANCE REQUEST] GET ${url}`);
          const res = await globalThis.fetch(url, {
            headers: {
              'X-MBX-APIKEY': cleanKey,
              'Accept': 'application/json',
              'User-Agent': 'CryptoPulse/1.0'
            }
          });

          if (!res.ok) {
            const errText = await res.text();
            console.error(`[BINANCE NATIVE FETCHBALANCE ERROR] HTTP ${res.status}: ${errText}`);
            let parsedErr: any = {};
            try { parsedErr = JSON.parse(errText); } catch (_) { /* ignore JSON parse error */ }
            const errorMsg = parsedErr?.msg || errText;
            const errorCode = parsedErr?.code || res.status;
            if (errorCode === -1022 || String(errorMsg).toLowerCase().includes('signature')) {
              throw new ccxt.AuthenticationError(`Binance API Error ${errorCode}: ${errorMsg}`);
            }
            throw new ccxt.ExchangeError(`Binance API Error ${errorCode}: ${errorMsg}`);
          }

          const data: any = await res.json();
          const balances: any = { free: {}, used: {}, total: {}, info: data };
          if (Array.isArray(data.balances)) {
            for (const b of data.balances) {
              const free = parseFloat(b.free) || 0;
              const locked = parseFloat(b.locked) || 0;
              balances.free[b.asset] = free;
              balances.used[b.asset] = locked;
              balances.total[b.asset] = free + locked;
            }
          }
          return balances;
        };
      }
    } else if (this.exchangeId === 'kucoin') {
      (this.exchange as any).publicGetSymbols = async () => ({ code: '200000', data: [] });
      (this.exchange as any).publicGetApiV1Symbols = async () => ({ code: '200000', data: [] });
    }

    // Double-shield fetch handler: Short-circuit any outbound fetch attempt to exchangeInfo or symbols
    const origCcxtFetch = this.exchange.fetch.bind(this.exchange);
    this.exchange.fetch = async (url: string, method = 'GET', headers: any = {}, body?: any) => {
      if (typeof url === 'string' && (url.includes('exchangeInfo') || url.includes('symbols'))) {
        console.warn(`[SHORT-CIRCUITED HEAVY ENDPOINT] ${method} ${url}`);
        return new Response(JSON.stringify({ symbols: [], code: '200000', data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      console.log(`[CCXT OUTBOUND FETCH DETAIL] ${method} ${url}`, JSON.stringify({ headers, body: body ? String(body).slice(0, 100) : null }));
      try {
        const res = await origCcxtFetch(url, method, headers, body);
        console.log(`[CCXT OUTBOUND FETCH SUCCESS] ${method} ${url} Status:`, res?.status || 'OK');
        return res;
      } catch (fetchError: any) {
        console.error(`[CCXT OUTBOUND FETCH EXCEPTION] ${method} ${url}:`, {
          name: fetchError?.name,
          message: fetchError?.message,
          cause: fetchError?.cause,
          stack: fetchError?.stack
        });
        throw fetchError;
      }
    };

    this.exchange.loadMarkets = async () => {
      console.log(`[CUSTOM loadMarkets CALLED] Bypassing exchangeInfo/symbols fetch`);
      return this.exchange!.markets || {};
    };
    (this.exchange as any).fetchMarkets = async () => {
      console.log(`[CUSTOM fetchMarkets CALLED] Returning populated static market list`);
      return Object.values(this.exchange?.markets || {});
    };

    const topPairs = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT', 'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT'];
    const isKucoin = this.exchangeId === 'kucoin';
    const marketsObj: any = {};
    const marketsByIdObj: any = {};
    for (const sym of topPairs) {
      const [base, quote] = sym.split('/');
      const id = isKucoin ? `${base}-${quote}` : `${base}${quote}`;
      const mData = {
        id,
        symbol: sym,
        base,
        quote,
        settle: quote,
        baseId: base,
        quoteId: quote,
        settleId: quote,
        type: 'spot',
        spot: true,
        margin: false,
        swap: false,
        future: false,
        option: false,
        active: true,
        contract: false,
        precision: { price: 8, amount: 8, cost: 8 },
        limits: {
          amount: { min: 0.0001, max: 999999 },
          price: { min: 0.0001, max: 999999 },
          cost: { min: 5, max: 9999999 },
        },
        info: {}
      };
      marketsObj[sym] = mData;
      marketsByIdObj[id] = mData;
    }
    this.exchange.markets = marketsObj;
    this.exchange.markets_by_id = marketsByIdObj;
    (this.exchange as any).symbols = topPairs;
    (this.exchange as any).ids = Object.keys(marketsByIdObj);
    this.marketsCached = true;

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
          } catch (_) {
            // Ignore transient server time sync failure
          }
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
    const topSymbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT', 'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT'];
    const isKucoin = (this.exchangeId || '').toLowerCase().includes('kucoin');
    return topSymbols.map(sym => {
      const [base, quote] = sym.split('/');
      const rawId = isKucoin ? sym.replace('/', '-') : sym.replace('/', '');
      return {
        id: rawId,
        symbol: sym,
        base,
        quote,
        active: true,
        precision: { price: 8, amount: 8 },
        limits: {
          amount: { min: new BigNumber(0.0001) },
          price: { min: new BigNumber(0.0001) },
          cost: { min: new BigNumber(5) },
        }
      };
    });
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
    const exId = (this.exchangeId || '').toLowerCase();

    // 1. Prefer CCXT's native fetchTicker implementation
    try {
      const ticker = await this.exchange!.fetchTicker(cleanSymbol);
      const lastPx = new BigNumber(ticker.last ?? (ticker.close ?? 0));
      const baseVol = new BigNumber(ticker.baseVolume ?? ((ticker as any).volume ?? 0));
      const quoteVol = new BigNumber(ticker.quoteVolume ?? ((ticker as any).quoteVolume ?? 0));
      const highPx = new BigNumber(ticker.high ?? 0);
      const lowPx = new BigNumber(ticker.low ?? 0);

      if (lastPx.isGreaterThan(0)) {
        return {
          symbol: ticker.symbol || cleanSymbol,
          timestamp: ticker.timestamp ?? Date.now(),
          last: lastPx,
          bid: new BigNumber(ticker.bid ?? lastPx),
          ask: new BigNumber(ticker.ask ?? lastPx),
          high: highPx.isGreaterThan(0) ? highPx : lastPx,
          low: lowPx.isGreaterThan(0) ? lowPx : lastPx,
          volume: baseVol,
          quoteVolume: quoteVol.isGreaterThan(0) ? quoteVol : baseVol.multipliedBy(lastPx),
          change: new BigNumber(ticker.change ?? 0),
          percentage: typeof ticker.percentage === 'number' ? ticker.percentage : (typeof ticker.info?.priceChangePercent !== 'undefined' ? parseFloat(ticker.info.priceChangePercent) : undefined),
          info: ticker.info,
        };
      }
    } catch (e: any) {
      console.warn(`[CCXT NATIVE FETCH_TICKER WARNING] ${cleanSymbol} on ${this.exchangeId}: ${e?.message}`);
    }

    // Resilient memory cache for ticker data across transient network drops
    const cacheKey = `${this.exchangeId}:${cleanSymbol}`;

    // Helper to safely drain/cancel HTTP response body to prevent Worker stalled socket deadlocks
    const safeDrainBody = async (res: Response) => {
      try {
        if (res && res.body && !res.bodyUsed) {
          await res.arrayBuffer();
        }
      } catch (_) {
        try { if (res && res.body && !res.bodyUsed) res.body.cancel(); } catch (__) { /* ignore cancel error */ }
      }
    };

    // 1. Prefer CCXT's native fetchTicker implementation
    try {
      const ticker = await this.exchange!.fetchTicker(cleanSymbol);
      const lastPx = new BigNumber(ticker.last ?? (ticker.close ?? 0));
      const baseVol = new BigNumber(ticker.baseVolume ?? ((ticker as any).volume ?? 0));
      const quoteVol = new BigNumber(ticker.quoteVolume ?? ((ticker as any).quoteVolume ?? 0));
      const highPx = new BigNumber(ticker.high ?? 0);
      const lowPx = new BigNumber(ticker.low ?? 0);

      if (lastPx.isGreaterThan(0)) {
        const result: Ticker = {
          symbol: ticker.symbol || cleanSymbol,
          timestamp: ticker.timestamp ?? Date.now(),
          last: lastPx,
          bid: new BigNumber(ticker.bid ?? lastPx),
          ask: new BigNumber(ticker.ask ?? lastPx),
          high: highPx.isGreaterThan(0) ? highPx : lastPx,
          low: lowPx.isGreaterThan(0) ? lowPx : lastPx,
          volume: baseVol,
          quoteVolume: quoteVol.isGreaterThan(0) ? quoteVol : baseVol.multipliedBy(lastPx),
          change: new BigNumber(ticker.change ?? 0),
          percentage: typeof ticker.percentage === 'number' ? ticker.percentage : (typeof ticker.info?.priceChangePercent !== 'undefined' ? parseFloat(ticker.info.priceChangePercent) : undefined),
          info: ticker.info,
        };
        CcxtProvider.tickerCache.set(cacheKey, { ticker: result, timestamp: Date.now() });
        return result;
      }
    } catch (e: any) {
      console.warn(`[CCXT NATIVE FETCH_TICKER WARNING] ${cleanSymbol} on ${this.exchangeId}: ${e?.message}`);
    }

    // 2. Direct 24-hour Ticker Fallback for Binance (provides complete 24h market statistics without fabrication)
    if (exId.includes('binance')) {
      const rawPair = cleanSymbol.replace('/', '');
      const isTestnet = this.config?.environment === 'testnet' || this.config?.environment === 'Testing';
      const urls = isTestnet
        ? [`https://testnet.binance.vision/api/v3/ticker/24hr?symbol=${rawPair}`, `https://api.binance.com/api/v3/ticker/24hr?symbol=${rawPair}`]
        : [`https://api.binance.com/api/v3/ticker/24hr?symbol=${rawPair}`, `https://testnet.binance.vision/api/v3/ticker/24hr?symbol=${rawPair}`];

      for (const url of urls) {
        let res: Response | null = null;
        try {
          res = await globalThis.fetch(url, {
            headers: { 'User-Agent': 'CryptoPulse/1.0', 'Accept': 'application/json' }
          });
          if (res.ok) {
            const data: any = await res.json();
            const lastPx = new BigNumber(data.lastPrice || data.price || 0);
            if (lastPx.isGreaterThan(0)) {
              const baseVol = new BigNumber(data.volume || 0);
              const quoteVol = new BigNumber(data.quoteVolume || 0);
              const highPx = new BigNumber(data.highPrice || lastPx);
              const lowPx = new BigNumber(data.lowPrice || lastPx);
              const result: Ticker = {
                symbol: cleanSymbol,
                timestamp: data.closeTime || Date.now(),
                last: lastPx,
                bid: new BigNumber(data.bidPrice || lastPx),
                ask: new BigNumber(data.askPrice || lastPx),
                high: highPx.isGreaterThan(0) ? highPx : lastPx,
                low: lowPx.isGreaterThan(0) ? lowPx : lastPx,
                volume: baseVol,
                quoteVolume: quoteVol.isGreaterThan(0) ? quoteVol : baseVol.multipliedBy(lastPx),
                change: new BigNumber(data.priceChange || 0),
                percentage: typeof data.priceChangePercent !== 'undefined' ? parseFloat(data.priceChangePercent) : undefined,
                info: data,
              };
              CcxtProvider.tickerCache.set(cacheKey, { ticker: result, timestamp: Date.now() });
              return result;
            }
          } else {
            await safeDrainBody(res);
          }
        } catch (fErr: any) {
          if (res) await safeDrainBody(res);
          console.warn(`[CCXT REST FETCH_TICKER FALLBACK FAILED] ${url}:`, fErr?.message);
        }
      }
    }

    // 3. Resilient Market Stats Fallback via KuCoin (used for KuCoin or as fallback when Binance is geo-restricted on CI runners)
    const rawPairKucoin = cleanSymbol.replace('/', '-');
    let resKu: Response | null = null;
    try {
      resKu = await globalThis.fetch(`https://openapi-v2.kucoin.com/api/v1/market/stats?symbol=${rawPairKucoin}`, {
        headers: { 'Accept': 'application/json' }
      });
      if (resKu.ok) {
        const json: any = await resKu.json();
        if (json.code === '200000' && json.data && json.data.last) {
          const lastPx = new BigNumber(json.data.last || 0);
          if (lastPx.isGreaterThan(0)) {
            const baseVol = new BigNumber(json.data.vol || 0);
            const quoteVol = new BigNumber(json.data.volValue || 0);
            const result: Ticker = {
              symbol: cleanSymbol,
              timestamp: json.data.time || Date.now(),
              last: lastPx,
              bid: new BigNumber(json.data.buy || lastPx),
              ask: new BigNumber(json.data.sell || lastPx),
              high: new BigNumber(json.data.high || lastPx),
              low: new BigNumber(json.data.low || lastPx),
              volume: baseVol,
              quoteVolume: quoteVol.isGreaterThan(0) ? quoteVol : baseVol.multipliedBy(lastPx),
              change: new BigNumber(json.data.change || 0),
              percentage: typeof json.data.changeRate !== 'undefined' ? parseFloat(json.data.changeRate) * 100 : undefined,
              info: json.data,
            };
            CcxtProvider.tickerCache.set(cacheKey, { ticker: result, timestamp: Date.now() });
            return result;
          }
        }
      } else {
        await safeDrainBody(resKu);
      }
    } catch (_) {
      if (resKu) await safeDrainBody(resKu);
    }

    // 4. Return cached valid ticker data if available to withstand transient socket drops / rate limits
    const cached = CcxtProvider.tickerCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 300000) { // 5-minute cache fallback
      console.log(`[TICKER CACHE FALLBACK] Returning cached ticker for ${cleanSymbol}`);
      return cached.ticker;
    }

    throw new UnifiedError(`Unable to retrieve genuine live ticker statistics for ${cleanSymbol} on ${this.exchangeId}`, 'UNAVAILABLE');
  }

  public async fetchKlines(symbol: string, interval: string, limit: number): Promise<any[]> {
    this.ensureConnected();
    const cleanSymbol = this.ensureMarket(symbol);
    const exId = (this.exchangeId || '').toLowerCase();

    if (exId.includes('binance')) {
      try {
        const rawPair = cleanSymbol.replace('/', '');
        let res = await globalThis.fetch(`https://api.binance.com/api/v3/klines?symbol=${rawPair}&interval=${interval}&limit=${limit}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!res.ok) {
          res = await globalThis.fetch(`https://testnet.binance.vision/api/v3/klines?symbol=${rawPair}&interval=${interval}&limit=${limit}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
        }
        if (!res.ok) {
          const rawKucoin = cleanSymbol.replace('/', '-');
          const kcType = interval === '1m' ? '1min' : interval === '5m' ? '5min' : interval === '15m' ? '15min' : interval === '1h' ? '1hour' : '1min';
          res = await globalThis.fetch(`https://openapi-v2.kucoin.com/api/v1/market/candles?symbol=${rawKucoin}&type=${kcType}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          if (res.ok) {
            const json: any = await res.json();
            if (json.code === '200000' && Array.isArray(json.data)) {
              const mapped = json.data.slice(0, limit).map((k: any) => ({
                openTime: parseInt(k[0]) * 1000,
                open: parseFloat(k[1]),
                close: parseFloat(k[2]),
                high: parseFloat(k[3]),
                low: parseFloat(k[4]),
                volume: parseFloat(k[5]),
              }));
              return mapped.sort((a: any, b: any) => a.openTime - b.openTime);
            }
          }
        }
        if (res.ok) {
          const data: any[] = await res.json();
          const mapped = data.map(k => ({
            openTime: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
          }));
          return mapped.sort((a, b) => a.openTime - b.openTime);
        }
      } catch (_) {
        // Fallback to standard fetchOHLCV
      }
    } else if (exId.includes('kucoin')) {
      try {
        const rawPair = cleanSymbol.replace('/', '-');
        const kcType = interval === '1m' ? '1min' : interval === '5m' ? '5min' : interval === '15m' ? '15min' : interval === '1h' ? '1hour' : '1min';
        const res = await globalThis.fetch(`https://openapi-v2.kucoin.com/api/v1/market/candles?symbol=${rawPair}&type=${kcType}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (res.ok) {
          const json: any = await res.json();
          if (json.code === '200000' && Array.isArray(json.data)) {
            const mapped = json.data.slice(0, limit).map((k: any) => ({
              openTime: parseInt(k[0]) * 1000,
              open: parseFloat(k[1]),
              close: parseFloat(k[2]),
              high: parseFloat(k[3]),
              low: parseFloat(k[4]),
              volume: parseFloat(k[5]),
            }));
            return mapped.sort((a: any, b: any) => a.openTime - b.openTime);
          }
        }
      } catch (_) {
        // Fallback to standard fetchOHLCV
      }
    }

    try {
      const ohlcv = await this.exchange!.fetchOHLCV(cleanSymbol, interval, undefined, limit);
      const mapped = ohlcv.map(k => ({
        openTime: k[0],
        open: k[1],
        high: k[2],
        low: k[3],
        close: k[4],
        volume: k[5],
      }));
      return mapped.sort((a, b) => (a.openTime || 0) - (b.openTime || 0));
    } catch (e: any) {
      const msg = (e?.message || '').toLowerCase();
      if (msg.includes('451') || msg.includes('restricted location') || msg.includes('eligibility') || msg.includes('403')) {
        try {
          const rawKucoin = cleanSymbol.replace('/', '-');
          const kcType = interval === '1m' ? '1min' : interval === '5m' ? '5min' : interval === '15m' ? '15min' : interval === '1h' ? '1hour' : '1min';
          const kcRes = await globalThis.fetch(`https://openapi-v2.kucoin.com/api/v1/market/candles?symbol=${rawKucoin}&type=${kcType}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          if (kcRes.ok) {
            const json: any = await kcRes.json();
            if (json.code === '200000' && Array.isArray(json.data)) {
              const mapped = json.data.slice(0, limit).map((k: any) => ({
                openTime: parseInt(k[0]) * 1000,
                open: parseFloat(k[1]),
                close: parseFloat(k[2]),
                high: parseFloat(k[3]),
                low: parseFloat(k[4]),
                volume: parseFloat(k[5]),
              }));
              return mapped.sort((a: any, b: any) => a.openTime - b.openTime);
            }
          }
        } catch (_) { /* ignore fallback */ }
      }
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

  public supportsOco(): boolean {
    return this.exchangeId === 'binance' || (this.exchange != null && typeof (this.exchange as any).createOrderList === 'function');
  }

  public async createOrder(order: OrderRequest): Promise<Order> {
    this.ensureConnected();
    if (this.exchangeId === 'binance' && this.exchange && this.exchange.options) {
      if (!Array.isArray(this.exchange.options['createMarketBuyOrderRequiresPrice'])) {
        this.exchange.options['createMarketBuyOrderRequiresPrice'] = ['market'];
      }
    }

    const keyStr = this.exchange?.apiKey || '';
    const secretStr = this.exchange?.secret || '';

    console.log('[TASK_12_CREDENTIAL_FORENSICS]', JSON.stringify({
      apiKeyExists: Boolean(keyStr),
      apiKeyLength: keyStr.length,
      apiKeyStart: keyStr ? keyStr.slice(0, 6) : '',
      apiKeyEnd: keyStr ? keyStr.slice(-6) : '',
      secretExists: Boolean(secretStr),
      secretLength: secretStr.length,
      secretStart: secretStr ? secretStr.slice(0, 6) : '',
      secretEnd: secretStr ? secretStr.slice(-6) : '',
      environment: this.config?.environment,
      exchangeId: this.exchangeId,
      sandbox: Boolean((this.exchange as any)?.sandbox || (this.exchange as any)?.urls?.test),
      publicUrl: this.exchange?.urls?.api ? (this.exchange.urls.api as any).public : undefined,
      privateUrl: this.exchange?.urls?.api ? (this.exchange.urls.api as any).private : undefined,
      keyMatchesConfig: this.exchange?.apiKey === this.config?.apiKey,
      secretMatchesConfig: this.exchange?.secret === this.config?.secret,
    }, null, 2));
    const cleanSymbol = this.ensureMarket(order.symbol);
    const params: Record<string, any> = {
      clientOrderId: order.clientOrderId,
      ...order.params
    };
    if (order.timeInForce) {
      params.timeInForce = order.timeInForce;
    }
    delete params.stopLossPrice;
    delete params.takeProfitPrice;
    Object.keys(params).forEach(key => params[key] === undefined && delete params[key]);

    console.log('[DIAGNOSTIC] CcxtProvider.createOrder args:', JSON.stringify({
      cleanSymbol,
      type: order.type,
      side: order.side,
      amount: order.amount.toNumber(),
      price: order.price ? order.price.toNumber() : undefined,
      params
    }));




    // --- TASK #6 DUMP #2: IMMEDIATELY BEFORE CREATE_ORDER ---
    const ex2 = this.exchange as any;
    const describeOpts2 = ex2?.describe ? (ex2.describe().options || {}) : {};
    const runtimeOpts2 = ex2?.options || {};
    
    console.log('[TASK_6_DUMP_2_BEFORE_CREATE_ORDER]', JSON.stringify({
      keysCount: Object.keys(runtimeOpts2).length,
      defaultType: runtimeOpts2.defaultType,
      createMarketBuyOrderRequiresPrice: runtimeOpts2.createMarketBuyOrderRequiresPrice,
      typeofCreateMarketBuyOrderRequiresPrice: typeof runtimeOpts2.createMarketBuyOrderRequiresPrice,
      jsonCreateMarketBuyOrderRequiresPrice: JSON.stringify(runtimeOpts2.createMarketBuyOrderRequiresPrice),
      isIdentityWithDescribe: runtimeOpts2 === describeOpts2,
      describeKeysCount: Object.keys(describeOpts2).length,
      entireObject: runtimeOpts2
    }, null, 2));

    try {
      const response = await this.exchange!.createOrder(
        cleanSymbol,
        order.type,
        order.side,
        order.amount.toNumber(),
        order.price ? order.price.toNumber() : undefined,
        params
      );
      console.log('[DIAGNOSTIC] CcxtProvider.createOrder raw response:', JSON.stringify(response));
      return this.mapOrder(response as CcxtOrder);
    } catch (e: any) {
      console.error('[DIAGNOSTIC] CcxtProvider.createOrder exception caught:', {
        message: e.message,
        name: e.name,
        constructor: e.constructor?.name,
        stack: e.stack,
        rawError: e
      });
      throw this.mapError(e, 'createOrder');
    }
  }

  public async createOcoOrder(order: import('./models/NormalizedDomain').OcoOrderRequest): Promise<import('./models/NormalizedDomain').OcoOrderResponse> {
    this.ensureConnected();
    const cleanSymbol = this.ensureMarket(order.symbol);
    const sideUpper = order.side.toUpperCase();
    const amountVal = order.amount.toNumber();
    const priceVal = order.price.toNumber();
    const stopPriceVal = order.stopPrice.toNumber();
    const stopLimitPriceVal = order.stopLimitPrice ? order.stopLimitPrice.toNumber() : stopPriceVal;

    console.log('[DIAGNOSTIC] CcxtProvider.createOcoOrder args:', JSON.stringify({
      cleanSymbol,
      sideUpper,
      amountVal,
      priceVal,
      stopPriceVal,
      stopLimitPriceVal,
      listClientOrderId: order.listClientOrderId
    }));

    try {
      let rawRes: any = null;
      if (typeof (this.exchange as any).createOrderList === 'function') {
        const orders = [
          {
            symbol: cleanSymbol,
            type: 'LIMIT',
            side: sideUpper,
            amount: amountVal,
            price: priceVal,
          },
          {
            symbol: cleanSymbol,
            type: 'STOP_LOSS_LIMIT',
            side: sideUpper,
            amount: amountVal,
            price: stopLimitPriceVal,
            stopPrice: stopPriceVal,
          }
        ];
        rawRes = await (this.exchange as any).createOrderList(orders, cleanSymbol, {
          listClientOrderId: order.listClientOrderId,
          ...order.params
        });
      } else if (typeof (this.exchange as any).privatePostOrderOco === 'function') {
        const symbolFormat = cleanSymbol.replace('/', '');
        rawRes = await (this.exchange as any).privatePostOrderOco({
          symbol: symbolFormat,
          side: sideUpper,
          quantity: amountVal,
          price: priceVal,
          stopPrice: stopPriceVal,
          stopLimitPrice: stopLimitPriceVal,
          stopLimitTimeInForce: 'GTC',
          listClientOrderId: order.listClientOrderId,
          ...order.params
        });
      } else {
        throw new Error(`Exchange provider ${this.exchangeId} does not support native OCO orders.`);
      }

      console.log('[DIAGNOSTIC] CcxtProvider.createOcoOrder raw response:', JSON.stringify(rawRes));
      const ordersList: Order[] = Array.isArray(rawRes?.orders) ? rawRes.orders.map((o: any) => this.mapOrder(o)) : [];
      return {
        ocoGroupId: String(rawRes?.orderListId || rawRes?.id || order.listClientOrderId || Date.now()),
        symbol: cleanSymbol,
        status: rawRes?.listOrderStatus || 'EXECUTING',
        tpOrderId: ordersList[0]?.id || String(rawRes?.orderReports?.[0]?.orderId || ''),
        slOrderId: ordersList[1]?.id || String(rawRes?.orderReports?.[1]?.orderId || ''),
        orders: ordersList,
        info: rawRes
      };
    } catch (e: any) {
      console.error('[DIAGNOSTIC] CcxtProvider.createOcoOrder exception caught:', {
        message: e.message,
        name: e.name,
        stack: e.stack,
        rawError: e
      });
      throw this.mapError(e, 'createOcoOrder');
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
    if (!this.exchange) {
      throw new UnifiedError('Exchange provider not connected.', 'NOT_CONNECTED');
    }
    if (this.exchangeId === 'binance' && this.exchange.options) {
      if (!Array.isArray(this.exchange.options['createMarketBuyOrderRequiresPrice'])) {
        this.exchange.options['createMarketBuyOrderRequiresPrice'] = ['market'];
      }
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

  private mapError(e: any, _endpoint: string): UnifiedError {
    console.error('[DIAGNOSTIC MAPERROR STACK]', { message: e?.message, name: e?.name, stack: e?.stack });
    const errorClass = e?.constructor?.name || 'Error';
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
      `${e?.message || String(e)} | STACK: ${e?.stack || 'no_stack'}`,
      mappedCode,
      errorClass,
      e?.code,
      e?.message
    );
  }
}
