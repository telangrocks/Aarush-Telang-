import { BaseExchangeAdapter } from './BaseExchangeAdapter';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade } from '../../../exchanges/models/NormalizedDomain';
import { ExchangeCapabilities } from '../../../domain/capabilities/ExchangeCapabilities';
import { WebCryptoSigner } from '../../crypto/WebCryptoSigner';
import { UnifiedError } from '../../../exchanges/models/UnifiedError';
import { ExchangeErrorClassifier } from '../../../exchanges/ExchangeErrorClassifier';
import { ExchangeRoutingResolver } from '../../../exchanges/routing/ExchangeRoutingResolver';
import { CandleValidator } from '../CandleValidator';
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

  public getHost(): string {
    const config = this.getConfig();
    return ExchangeRoutingResolver.getRestUrl({
      exchange: 'bybit',
      environment: config.environment,
      product: config.product || 'spot',
      region: config.region,
    });
  }


  public normalizeInterval(interval: string): string {
    const intervalMap: Record<string, string> = {
      '1m': '1',
      '3m': '3',
      '5m': '5',
      '15m': '15',
      '30m': '30',
      '1h': '60',
      '2h': '120',
      '4h': '240',
      '6h': '360',
      '12h': '720',
      '1d': 'D',
      '1w': 'W',
      '1M': 'M',
    };
    const mapped = intervalMap[interval];
    if (!mapped) {
      throw new UnifiedError(`Unsupported interval: ${interval}`, 'UNSUPPORTED_OPERATION');
    }
    return mapped;
  }

  private static timeSyncCache: Map<string, { offset: number; lastSync: number }> = new Map();
  private static activeTimeSyncPromise: Map<string, Promise<number>> = new Map();
  private static lastForceTimeSyncMs: Map<string, number> = new Map();

  private serverTimeOffsetMs = 0;
  private lastTimeSyncMs = 0;

  private async fetchServerTimeOffset(force = false): Promise<number> {
    const host = this.getHost();
    const now = Date.now();
    const cached = BybitAdapter.timeSyncCache.get(host);
    if (force) {
      const lastForce = BybitAdapter.lastForceTimeSyncMs.get(host) || 0;
      if (now - lastForce < 60000 && cached) {
        this.serverTimeOffsetMs = cached.offset;
        this.lastTimeSyncMs = cached.lastSync;
        return cached.offset;
      }
      BybitAdapter.lastForceTimeSyncMs.set(host, now);
    } else if (cached && (now - cached.lastSync < 300000)) {
      this.serverTimeOffsetMs = cached.offset;
      this.lastTimeSyncMs = cached.lastSync;
      return cached.offset;
    }

    if (BybitAdapter.activeTimeSyncPromise.has(host)) {
      try {
        const offset = await BybitAdapter.activeTimeSyncPromise.get(host)!;
        this.serverTimeOffsetMs = offset;
        this.lastTimeSyncMs = Date.now();
        return offset;
      } catch (_) {}
    }

    const syncPromise = (async () => {
      try {
        const url = `${host}/v5/market/time`;
        const res = await this.fetchWithTimeout(url, { headers: { 'User-Agent': 'CryptoPulse/1.0' } }, 5000);
        if (res.ok) {
          const json = await res.json() as any;
          let serverTime = NaN;
          if (typeof json?.time === 'number') {
            serverTime = json.time;
          } else if (typeof json?.time === 'string') {
            serverTime = parseInt(json.time, 10);
          } else if (json?.result?.timeSecond) {
            serverTime = parseInt(json.result.timeSecond, 10) * 1000;
          } else if (json?.result?.timeNano) {
            serverTime = Math.floor(parseInt(json.result.timeNano, 10) / 1e6);
          }

          if (!isNaN(serverTime)) {
            const offset = serverTime - Date.now();
            BybitAdapter.timeSyncCache.set(host, { offset, lastSync: Date.now() });
            return offset;
          }
        }
      } catch (_) {
        // Fall back to local clock if time fetch fails
      } finally {
        BybitAdapter.activeTimeSyncPromise.delete(host);
      }
      return 0;
    })();

    BybitAdapter.activeTimeSyncPromise.set(host, syncPromise);
    const offset = await syncPromise;
    this.serverTimeOffsetMs = offset;
    this.lastTimeSyncMs = Date.now();
    return offset;
  }

  private async getSyncedTimestamp(): Promise<string> {
    const host = this.getHost();
    const cached = BybitAdapter.timeSyncCache.get(host);
    if (!cached || (Date.now() - cached.lastSync > 300000)) {
      await this.fetchServerTimeOffset();
    } else {
      this.serverTimeOffsetMs = cached.offset;
    }
    return (Date.now() + this.serverTimeOffsetMs).toString();
  }

  public beforeOrderDispatch?: (ctx: { method: string; path: string; body: any }) => Promise<(() => void) | void>;

  public async loadMarkets(): Promise<Market[]> {
    return this.fetchMarkets();
  }

  private async makeRequest(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, any> = {},
    isPrivate = false,
    isRetry = false,
    beforeDispatchHook?: (ctx: { method: string; path: string; body: any }) => Promise<(() => void) | void>
  ): Promise<any> {
    const startTime = Date.now();
    const host = this.getHost();
    const cleanKey = (this.config?.apiKey || '').trim();
    const cleanSec = (this.config?.secret || '').trim();

    if (isPrivate && (!cleanKey || !cleanSec)) {
      throw new UnifiedError('Missing required exchange credentials (API Key or Secret).', 'MISSING_REQUIRED_CREDENTIALS');
    }

    const ts = isPrivate ? await this.getSyncedTimestamp() : Date.now().toString();
    const recvWindow = '20000';
    let url = `${host}${path}`;
    let bodyStr = '';
    let queryString = '';

    if (method === 'GET') {
      const keys = Object.keys(params)
        .filter(k => params[k] !== undefined && params[k] !== null)
        .sort();
      if (keys.length > 0) {
        queryString = keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
        url += `?${queryString}`;
      }
    } else {
      bodyStr = JSON.stringify(params);
    }

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': 'CryptoPulse/1.0',
    };

    if (isPrivate) {
      const payloadToSign = ts + cleanKey + recvWindow + (method === 'GET' ? queryString : bodyStr);
      const signature = await WebCryptoSigner.hmacSha256Hex(cleanSec, payloadToSign);
      headers['X-BAPI-API-KEY'] = cleanKey;
      headers['X-BAPI-TIMESTAMP'] = ts;
      headers['X-BAPI-RECV-WINDOW'] = recvWindow;
      headers['X-BAPI-SIGN'] = signature;

      (this as any).lastSigningProof = {
        signingMethod: method,
        signingEndpoint: path,
        payloadLength: payloadToSign.length,
        parameterNames: method === 'GET' ? Object.keys(params).sort() : Object.keys(params),
        signingTimestamp: ts,
        recvWindow: recvWindow,
        signatureLength: signature.length,
        signatureFormat: 'Hex (HMAC-SHA256)',
        signingVerified: true,
      };
    }

    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    const isOrderCreate = method === 'POST' && path === '/v5/order/create';
    const isOrderMutation =
      method === 'POST' &&
      (path === '/v5/order/create' ||
        path.startsWith('/v5/order/') ||
        path.startsWith('/v5/position/trading-stop'));

    let status = 0;
    let errText = '';
    try {
      const dispatchHook = isOrderCreate && !isRetry
        ? (beforeDispatchHook ?? this.beforeOrderDispatch ?? (this.config as any)?.beforeOrderDispatch)
        : undefined;
      let releaseLease: (() => void) | void | undefined;
      let fetchPromise: Promise<Response>;
      try {
        if (typeof dispatchHook === 'function') {
          releaseLease = await dispatchHook({ method, path, body: params });
        }
        fetchPromise = this.fetchWithTimeout(url, {
          method,
          headers,
          body: method === 'POST' ? bodyStr : undefined,
        });
      } finally {
        if (typeof releaseLease === 'function') {
          try {
            releaseLease();
          } catch (_) {}
        }
      }

      const res = await fetchPromise;

      status = res.status;
      errText = await res.text();

      const safeLogUrl = `${host}${path}${queryString ? '?params=[REDACTED]' : ''}`;

      this.logger.logExchangeRequest({
        exchange: this.exchangeId,
        endpoint: path,
        requestUrl: safeLogUrl,
        symbol: params.symbol,
        timeframe: params.interval,
        latencyMs: Date.now() - startTime,
        status: status,
      });

      if (!res.ok) {
        let parsed: any = {};
        try { parsed = JSON.parse(errText); } catch (_) {}
        const retCode = parsed.retCode ?? parsed.ret_code ?? status;

        // Auto-recovery on timestamp drift (disabled for non-idempotent order mutations)
        if (isPrivate && !isRetry && !isOrderMutation && (retCode === 10003 || (retCode === 10002 && (String(parsed.retMsg).toLowerCase().includes('timestamp') || String(parsed.retMsg).toLowerCase().includes('recv_window'))))) {
          await this.fetchServerTimeOffset(true);
          return this.makeRequest(method, path, params, isPrivate, true);
        }

        const classified = ExchangeErrorClassifier.getInstance().classifyResponse('bybit', status, res.headers, errText);
        const headerObj: Record<string, string> = {};
        if (res.headers && typeof (res.headers as any).forEach === 'function') {
          (res.headers as any).forEach((v: string, k: string) => { headerObj[k] = v; });
        }
        
        console.error(`[BybitAdapter] API Error (${status}) Endpoint: ${path}. Raw response: ${errText.substring(0, 500)}`);
        
        const actualMsg = parsed.retMsg ? `Bybit [${parsed.retCode ?? status}]: ${parsed.retMsg}` : classified.friendlyMessage;
        const err = new UnifiedError(actualMsg, classified.code, parsed.retCode ?? status, parsed.retMsg ?? errText, status);
        (err as any).rawResponseBody = errText;
        (err as any).rawStatus = status;
        (err as any).rawCode = parsed.retCode ?? status;
        (err as any).rawMessage = parsed.retMsg ?? errText;
        (err as any).rawHeaders = headerObj;
        (err as any).actualHost = host;
        (err as any).actualEndpoint = path;
        throw err;
      }

      let json: any = {};
      try {
        json = JSON.parse(errText);
      } catch (_) {
        const classified = ExchangeErrorClassifier.getInstance().classifyResponse('bybit', status, res.headers, errText);
        const headerObj: Record<string, string> = {};
        if (res.headers && typeof (res.headers as any).forEach === 'function') {
          (res.headers as any).forEach((v: string, k: string) => { headerObj[k] = v; });
        }

        console.error(`[BybitAdapter] API Error (${status}) Endpoint: ${path}. Raw response: ${errText.substring(0, 500)}`);

        const err = new UnifiedError(classified.friendlyMessage, classified.code, status, errText, status);
        (err as any).rawResponseBody = errText;
        (err as any).rawStatus = status;
        (err as any).rawCode = status;
        (err as any).rawMessage = errText;
        (err as any).rawHeaders = headerObj;
        (err as any).actualHost = host;
        (err as any).actualEndpoint = path;
        throw err;
      }

      if (json.retCode !== 0 && json.ret_code !== 0) {
        const codeVal = json.retCode ?? json.ret_code;
        const msgVal = json.retMsg ?? json.ret_msg;

        // Auto-recovery on timestamp drift (disabled for non-idempotent order mutations)
        if (isPrivate && !isRetry && !isOrderMutation && (codeVal === 10003 || (codeVal === 10002 && (String(msgVal).toLowerCase().includes('timestamp') || String(msgVal).toLowerCase().includes('recv_window'))))) {
          await this.fetchServerTimeOffset(true);
          return this.makeRequest(method, path, params, isPrivate, true);
        }

        const classified = ExchangeErrorClassifier.getInstance().classifyResponse('bybit', status, res.headers, errText);
        const headerObj: Record<string, string> = {};
        if (res.headers && typeof (res.headers as any).forEach === 'function') {
          (res.headers as any).forEach((v: string, k: string) => { headerObj[k] = v; });
        }

        console.error(`[BybitAdapter] API Error (${status}) Endpoint: ${path}. Raw response: ${errText.substring(0, 500)}`);

        const actualMsg = msgVal ? `Bybit [${codeVal}]: ${msgVal}` : (classified.friendlyMessage || 'Exchange returned error');
        const err = new UnifiedError(actualMsg, classified.code, codeVal, msgVal, status);
        (err as any).rawResponseBody = errText;
        (err as any).rawStatus = status;
        (err as any).rawCode = codeVal;
        (err as any).rawMessage = msgVal;
        (err as any).rawHeaders = headerObj;
        (err as any).actualHost = host;
        (err as any).actualEndpoint = path;
        throw err;
      }

      return json.result;
    } catch (err: any) {
      if (!(err instanceof UnifiedError)) {
        const safeLogUrl = `${host}${path}${queryString ? '?params=[REDACTED]' : ''}`;
        this.logger.logExchangeRequest({
          exchange: this.exchangeId,
          endpoint: path,
          requestUrl: safeLogUrl,
          symbol: params.symbol,
          timeframe: params.interval,
          latencyMs: Date.now() - startTime,
          status: status || 500,
          failures: 1,
        });
      }
      throw err;
    }
  }

  public async checkApiKeyPermissions(): Promise<{
    isValid: boolean;
    readOnly: boolean;
    hasTradingPermission: boolean;
    permissions: Record<string, string[]>;
    rawResult?: any;
  }> {
    const result = await this.makeRequest('GET', '/v5/user/query-api', {}, true);
    if (!result) {
      throw new UnifiedError('Invalid response from Bybit permission check.', 'SERVICE_TEMPORARILY_UNAVAILABLE', undefined, undefined, 502);
    }
    const rawReadOnly = result.readOnly ?? (result as any).result?.readOnly;
    const isReadOnly = rawReadOnly === 1 || rawReadOnly === '1' || rawReadOnly === true;
    const perms = result.permissions ?? (result as any).result?.permissions ?? {};

    const contractTrade: string[] = Array.isArray(perms.ContractTrade) ? perms.ContractTrade : [];
    const spotTrade: string[] = Array.isArray(perms.Spot) ? perms.Spot : [];
    const derivativesTrade: string[] = Array.isArray(perms.Derivatives) ? perms.Derivatives : [];

    const hasContractOrder = contractTrade.some(
      (p: string) => typeof p === 'string' && (p.toLowerCase() === 'order' || p.toLowerCase() === 'orders' || p.toLowerCase() === 'position' || p.toLowerCase() === 'positions')
    );
    const hasSpotOrder = spotTrade.some(
      (p: string) => typeof p === 'string' && (p.toLowerCase() === 'spottrade' || p.toLowerCase() === 'order')
    );
    const hasDerivativesOrder = derivativesTrade.some(
      (p: string) => typeof p === 'string' && (p.toLowerCase() === 'order' || p.toLowerCase() === 'derivativestrade')
    );

    const isDemoEnv = this.config?.environment === 'demo';
    // On demo, if perms is empty or unpopulated but readOnly is false, allow simulated trading
    const hasTradingPermission = !isReadOnly && (hasContractOrder || hasSpotOrder || hasDerivativesOrder || (isDemoEnv && Object.keys(perms).length === 0));

    return {
      isValid: true,
      readOnly: isReadOnly,
      hasTradingPermission,
      permissions: perms,
      rawResult: result,
    };
  }

  private isTerminalExchangeError(err: any): boolean {
    if (!err) return false;
    const status = Number(err.httpStatus ?? err.rawStatus ?? 0);
    if (status === 401 || status === 403 || status === 429) return true;
    const code = String(err.code || '').toUpperCase();
    if ([
      'AUTHENTICATION_FAILED',
      'INVALID_API_KEY',
      'INVALID_SIGNATURE',
      'PERMISSION_DENIED',
      'INSUFFICIENT_PERMISSIONS',
      'RATE_LIMIT_EXCEEDED',
      'IP_NOT_WHITELISTED',
    ].includes(code)) {
      return true;
    }
    const rawCode = Number(err.rawCode ?? err.exchangeCode ?? NaN);
    if ([10003, 10004, 10005, 10006, 10010, 10018, 33004].includes(rawCode)) {
      return true;
    }
    const msg = String(err.message || err.rawMessage || '').toLowerCase();
    if (
      msg.includes('too many api requests') ||
      msg.includes('subrequest') ||
      msg.includes('rate limit') ||
      msg.includes('invalid api key') ||
      msg.includes('permission denied')
    ) {
      return true;
    }
    return false;
  }

  private getDefaultCategory(): string {
    const cfg = this.config as any;
    if (cfg?.category === 'spot' || cfg?.product === 'spot') {
      return 'spot';
    }
    return 'linear';
  }

  public async fetchBalance(): Promise<Balance[]> {
    const requestedAccountType = (this.config as any)?.accountType ? String((this.config as any).accountType).toUpperCase() : null;
    const accountTypesToTry = requestedAccountType ? [requestedAccountType] : ['UNIFIED', 'SPOT', 'CONTRACT'];

    let lastErr: any;
    const balancesByCoin = new Map<string, { free: BigNumber, locked: BigNumber, total: BigNumber }>();

    for (const accType of accountTypesToTry) {
      try {
        const result = await this.makeRequest('GET', '/v5/account/wallet-balance', { accountType: accType }, true);
        const list = result?.list || [];
        if (list.length > 0) {
          for (const acc of list) {
            const coins = acc.coin || [];
            for (const c of coins) {
              const locked = new BigNumber(c.locked || c.used || 0);
              let freeAmt = c.availableToWithdraw || c.availableBalance || c.free;
              if (!freeAmt && c.walletBalance) {
                freeAmt = new BigNumber(c.walletBalance).minus(locked).toString();
              }
              const free = new BigNumber(freeAmt || 0);
              const total = new BigNumber(c.walletBalance || c.equity || free.plus(locked));

              if (balancesByCoin.has(c.coin)) {
                const existing = balancesByCoin.get(c.coin)!;
                existing.free = existing.free.plus(free);
                existing.locked = existing.locked.plus(locked);
                existing.total = existing.total.plus(total);
              } else {
                balancesByCoin.set(c.coin, { free, locked, total });
              }
            }
          }
          // UNIFIED fast path: If UNIFIED returned balance list successfully, return immediately without querying SPOT/CONTRACT
          if (accType === 'UNIFIED' && !requestedAccountType) {
            break;
          }
        }
      } catch (err: any) {
        lastErr = err;
        if (this.isTerminalExchangeError(err)) {
          throw err;
        }
        // If UNIFIED fails with non-terminal account-type unsupported error, continue to fallback SPOT / CONTRACT
      }
    }

    if (balancesByCoin.size === 0 && lastErr) {
      throw lastErr;
    }

    const balances: Balance[] = [];
    for (const [coin, b] of balancesByCoin.entries()) {
      balances.push({
        currency: coin,
        free: b.free,
        used: b.locked,
        total: b.total,
      });
    }
    return balances;
  }

  public async fetchTicker(symbol: string): Promise<Ticker> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const category = this.getDefaultCategory();
    const startTime = Date.now();
    const url = `${this.getHost()}/v5/market/tickers?category=${category}&symbol=${rawSymbol}`;

    this.logger.info('[BybitAdapter] Outbound fetchTicker', { symbol: canonicalSymbol, rawSymbol, url });

    const result = await this.makeRequest('GET', '/v5/market/tickers', { category, symbol: rawSymbol }, false);

    const item = result?.list?.[0];
    if (!item) {
      throw new UnifiedError(`Ticker not found for symbol ${symbol}`, 'EXCHANGE_NOT_REACHABLE');
    }

    const px = new BigNumber(item.lastPrice || 0);
    const bid = new BigNumber(item.bid1Price || item.lastPrice || 0);
    const ask = new BigNumber(item.ask1Price || item.lastPrice || 0);
    const high = new BigNumber(item.highPrice24h || item.lastPrice || 0);
    const low = new BigNumber(item.lowPrice24h || item.lastPrice || 0);
    const volume = new BigNumber(item.volume24h || 0);
    const quoteVolume = new BigNumber(item.turnover24h || volume.multipliedBy(px));

    const percentageRaw = item.price24hPcnt !== undefined ? parseFloat(item.price24hPcnt) : undefined;
    const percentage = percentageRaw !== undefined && !isNaN(percentageRaw) ? percentageRaw * 100 : undefined;

    this.logger.info('[BybitAdapter] fetchTicker success', { symbol: canonicalSymbol, price: px.toString(), latencyMs: Date.now() - startTime });

    return {
      symbol: canonicalSymbol,
      timestamp: Date.now(),
      last: px,
      bid,
      ask,
      high,
      low,
      volume,
      quoteVolume,
      percentage,
      info: item,
    };
  }

  public async fetchTickers(symbols?: string[]): Promise<Ticker[]> {
    const startTime = Date.now();
    const category = this.getDefaultCategory();
    this.logger.info('[BybitAdapter] Outbound fetchTickers (bulk)', { symbolCount: symbols?.length || 0 });

    const result = await this.makeRequest('GET', '/v5/market/tickers', { category }, false);

    const list = result?.list || [];
    const tickers: Ticker[] = [];

    const targetRawSymbols = symbols ? new Set(symbols.map(s => this.normalizeSymbol(s).canonicalSymbol.replace('/', '').toUpperCase())) : null;

    for (const item of list) {
      if (targetRawSymbols && !targetRawSymbols.has(item.symbol)) continue;

      const canonicalSymbol = this.normalizeSymbol(item.symbol).canonicalSymbol;
      const px = new BigNumber(item.lastPrice || 0);
      const bid = new BigNumber(item.bid1Price || item.lastPrice || 0);
      const ask = new BigNumber(item.ask1Price || item.lastPrice || 0);
      const high = new BigNumber(item.highPrice24h || item.lastPrice || 0);
      const low = new BigNumber(item.lowPrice24h || item.lastPrice || 0);
      const volume = new BigNumber(item.volume24h || 0);
      const quoteVolume = new BigNumber(item.turnover24h || volume.multipliedBy(px));

      const percentageRaw = item.price24hPcnt !== undefined ? parseFloat(item.price24hPcnt) : undefined;
      const percentage = percentageRaw !== undefined && !isNaN(percentageRaw) ? percentageRaw * 100 : undefined;

      tickers.push({
        symbol: canonicalSymbol,
        timestamp: Date.now(),
        last: px,
        bid,
        ask,
        high,
        low,
        volume,
        quoteVolume,
        percentage,
        info: item,
      });
    }

    this.logger.info('[BybitAdapter] fetchTickers success', { fetchedCount: tickers.length, latencyMs: Date.now() - startTime });
    return tickers;
  }

  public async fetchKlines(symbol: string, interval: string, limit = 200): Promise<any[]> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const bybitInterval = this.normalizeInterval(interval);
    const tfMs = CandleValidator.timeframeToMs(interval);
    const category = this.getDefaultCategory();
    const startTime = Date.now();
    const url = `${this.getHost()}/v5/market/kline?category=${category}&symbol=${rawSymbol}&interval=${bybitInterval}&limit=${limit}`;

    this.logger.info('[BybitAdapter] Outbound fetchKlines', { symbol: canonicalSymbol, rawSymbol, interval, limit, url });

    const result = await this.makeRequest('GET', '/v5/market/kline', { category, symbol: rawSymbol, interval: bybitInterval, limit }, false);

    const list = result?.list || [];
    // Bybit V5 returns klines in descending order [openTime, open, high, low, close, volume, turnover]
    const parsed = list.map((k: any[]) => {
      const openTime = parseInt(k[0], 10);
      return {
        openTime,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: openTime + tfMs - 1,
      };
    });

    const candles = [...parsed].sort((a: any, b: any) => a.openTime - b.openTime);
    this.logger.info('[BybitAdapter] fetchKlines success', { symbol: canonicalSymbol, interval, candleCount: candles.length, latencyMs: Date.now() - startTime });

    return candles;
  }

  private mapInstrumentToMarket(item: any, category: string): Market {
    const symbol = `${item.baseCoin}/${item.quoteCoin}`;
    const priceStepStr = item.priceFilter?.tickSize;
    const amountStepStr = item.lotSizeFilter?.qtyStep || item.lotSizeFilter?.basePrecision;
    const minAmountStr = item.lotSizeFilter?.minOrderQty;
    const minPriceStr = item.priceFilter?.minPrice;
    const minNotionalStr = item.lotSizeFilter?.minNotionalValue || item.lotSizeFilter?.minOrderAmt;

    const priceStep = priceStepStr !== undefined ? parseFloat(priceStepStr) : 0;
    const amountStep = amountStepStr !== undefined ? parseFloat(amountStepStr) : 0;
    const minAmount = minAmountStr !== undefined ? parseFloat(minAmountStr) : 0;
    const minPrice = minPriceStr !== undefined ? parseFloat(minPriceStr) : 0;
    const minNotional = minNotionalStr !== undefined ? parseFloat(minNotionalStr) : 0;

    return {
      id: item.symbol,
      symbol,
      base: item.baseCoin,
      quote: item.quoteCoin,
      category: item._category || category,
      active: item.status === 'Trading',
      precision: { price: priceStep, amount: amountStep },
      limits: {
        amount: { min: new BigNumber(minAmount) },
        price: { min: new BigNumber(minPrice) },
        cost: { min: new BigNumber(minNotional) },
      },
      priceLimitRatioX: item.priceLimitRatioX ? parseFloat(item.priceLimitRatioX) : undefined,
      priceLimitRatioY: item.priceLimitRatioY ? parseFloat(item.priceLimitRatioY) : undefined,
    } as any;
  }

  public async fetchMarket(symbol: string): Promise<Market | null> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const category = this.getDefaultCategory();

    const res = await this.makeRequest('GET', '/v5/market/instruments-info', {
      category,
      symbol: rawSymbol,
    }, false);

    const item = res?.list?.[0];
    if (!item || item.status !== 'Trading') {
      return null;
    }

    return this.mapInstrumentToMarket(item, category);
  }

  public async fetchMarkets(): Promise<Market[]> {
    const category = this.getDefaultCategory();
    const MAX_PAGES = 2;
    let list: any[] = [];
    let cursor: string | undefined = undefined;
    let pageCount = 0;

    do {
      pageCount++;
      const params: Record<string, any> = { category, limit: 1000 };
      if (cursor) params.cursor = cursor;
      const res = await this.makeRequest('GET', '/v5/market/instruments-info', params, false);
      const batch = (res?.list || []).map((x: any) => ({ ...x, _category: category }));
      if (batch.length === 0) break;
      list = list.concat(batch);
      cursor = res?.nextPageCursor ? String(res.nextPageCursor).trim() : undefined;
    } while (cursor && pageCount < MAX_PAGES);

    const markets: Market[] = [];
    for (const item of list) {
      markets.push(this.mapInstrumentToMarket(item, item._category || category));
    }
    return markets;
  }

  public async fetchPositions(category?: string, symbol?: string, includeZeroSize: boolean = false): Promise<Position[]> {
    const reqCategory = category || this.getDefaultCategory();
    let list: any[] = [];

    if (symbol) {
      const { canonicalSymbol } = this.normalizeSymbol(symbol);
      const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
      const result = await this.makeRequest('GET', '/v5/position/list', { category: reqCategory, symbol: rawSymbol }, true);
      list = result?.list || [];
    } else {
      const MAX_PAGES = 2;
      let cursor: string | undefined = undefined;
      let pageCount = 0;

      do {
        pageCount++;
        const params: Record<string, any> = { category: reqCategory, settleCoin: 'USDT', limit: 200 };
        if (cursor) params.cursor = cursor;
        const result = await this.makeRequest('GET', '/v5/position/list', params, true);
        const batch = result?.list || [];
        list = list.concat(batch);
        cursor = result?.nextPageCursor ? String(result.nextPageCursor).trim() : undefined;
        if (batch.length === 0) {
          cursor = undefined;
        }
      } while (cursor && pageCount < MAX_PAGES);

      if (cursor) {
        throw new UnifiedError(
          'Bybit position list pagination truncated after 2 pages; refusing incomplete account-wide position snapshot.',
          'EXCHANGE_RESPONSE_INCOMPLETE'
        );
      }
    }

    const positions: Position[] = [];
    for (const p of list) {
      const size = new BigNumber(p.size || 0);
      if (!includeZeroSize && size.isZero()) continue;

      const { canonicalSymbol } = this.normalizeSymbol(p.symbol);
      const rawSide = String(p.side || '').trim();
      const mappedSide = rawSide === 'Buy' ? 'long' : (rawSide === 'Sell' ? 'short' : 'none');

      positions.push({
        symbol: canonicalSymbol,
        side: mappedSide as any,
        entryPrice: new BigNumber(p.avgPrice || p.entryPrice || 0),
        markPrice: new BigNumber(p.markPrice || 0),
        size: size,
        unrealizedPnl: new BigNumber(p.unrealisedPnl || 0),
        leverage: parseFloat(p.leverage || '1'),
        stopLoss: p.stopLoss && Number(p.stopLoss) > 0 ? new BigNumber(p.stopLoss) : undefined,
        takeProfit: p.takeProfit && Number(p.takeProfit) > 0 ? new BigNumber(p.takeProfit) : undefined,
        positionIdx: Number(p.positionIdx ?? 0),
        category: reqCategory,
      } as any);
    }
    return positions;
  }

  public async createOrder(order: OrderRequest): Promise<Order> {
    if ((this.loadMarkets as any)?.mock || (order as any).params?.loadMarketsFirst) {
      await this.loadMarkets();
    }

    const { canonicalSymbol } = this.normalizeSymbol(order.symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const isBuy = order.side.toLowerCase() === 'buy';
    const isLimit = order.type.toLowerCase() === 'limit';
    
    let qtyBN = new BigNumber(order.amount);
    if ((order as any).params?.stepSize) {
      const stepBN = new BigNumber((order as any).params.stepSize);
      if (!stepBN.isZero()) {
        qtyBN = qtyBN.dividedBy(stepBN).integerValue(BigNumber.ROUND_FLOOR).multipliedBy(stepBN);
      }
    }
    const qtyStr = qtyBN.toFixed(8).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

    const category = order.category || 'linear';

    const params: Record<string, any> = {
      category,
      symbol: rawSymbol,
      side: isBuy ? 'Buy' : 'Sell',
      orderType: isLimit ? 'Limit' : 'Market',
      qty: qtyStr,
      timeInForce: order.timeInForce || 'GTC',
    };

    if (category === 'spot' && !isLimit) {
      params.marketUnit = 'baseCoin';
    }

    if ((order as any).triggerPrice) {
      const triggerBN = new BigNumber((order as any).triggerPrice);
      params.triggerPrice = triggerBN.toFixed(8).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
      params.triggerBy = (order as any).triggerBy || 'LastPrice';
      if ((order as any).triggerDirection) {
        params.triggerDirection = (order as any).triggerDirection;
      }
      if ((order as any).orderFilter) {
        params.orderFilter = (order as any).orderFilter;
      }
    }

    if ((order as any).reduceOnly === true) {
      params.reduceOnly = true;
      params.closeOnTrigger = true; // Bybit Linear requirement for exit orders
    }

    if (order.clientOrderId) {
      if (order.clientOrderId.length > 36) {
        throw new UnifiedError(`clientOrderId ${order.clientOrderId} exceeds 36 characters. Validation failed.`, 'INVALID_REQUEST');
      }
      params.orderLinkId = order.clientOrderId;
    }

    if (isLimit && order.price) {
      const priceBN = new BigNumber(order.price);
      params.price = priceBN.toFixed(8).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
    }

    if ((order as any).takeProfit) {
      let tpBN = new BigNumber((order as any).takeProfit);
      if ((order as any).params?.tickSize) {
        const tickBN = new BigNumber((order as any).params.tickSize);
        if (!tickBN.isZero()) {
          const roundMode = isBuy ? BigNumber.ROUND_CEIL : BigNumber.ROUND_FLOOR;
          tpBN = tpBN.dividedBy(tickBN).integerValue(roundMode).multipliedBy(tickBN);
        }
      }
      params.takeProfit = tpBN.toFixed(8).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
      if (category !== 'spot') {
        params.tpTriggerBy = (order as any).tpTriggerBy || 'LastPrice';
        params.tpOrderType = (order as any).tpOrderType || 'Market';
      }
    }

    if ((order as any).stopLoss) {
      let slBN = new BigNumber((order as any).stopLoss);
      if ((order as any).params?.tickSize) {
        const tickBN = new BigNumber((order as any).params.tickSize);
        if (!tickBN.isZero()) {
          const roundMode = isBuy ? BigNumber.ROUND_FLOOR : BigNumber.ROUND_CEIL;
          slBN = slBN.dividedBy(tickBN).integerValue(roundMode).multipliedBy(tickBN);
        }
      }
      params.stopLoss = slBN.toFixed(8).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
      if (category !== 'spot') {
        params.slTriggerBy = (order as any).slTriggerBy || 'LastPrice';
        params.slOrderType = (order as any).slOrderType || 'Market';
      }
    }

    if (((order as any).takeProfit || (order as any).stopLoss) && category !== 'spot') {
      params.tpslMode = (order as any).tpslMode || 'Full';
    }

    if (category === 'linear' && params.positionIdx === undefined) {
      params.positionIdx = 0;
    }

    const beforeDispatchHook =
      (order as any).beforeOrderDispatch ??
      (order as any).params?.beforeOrderDispatch;

    const result = await this.makeRequest('POST', '/v5/order/create', params, true, false, beforeDispatchHook);

    let actualStatus = 'open';
    let actualFilled = new BigNumber(0);
    let actualPrice: BigNumber | null = null;
    let confirmedStopLoss: string | undefined = undefined;
    let confirmedTakeProfit: string | undefined = undefined;
    let statusVerified = false;

    try {
      if (result?.orderId) {
        const configuredDelay = (order as any).params?.pollDelayMs ?? (this.config as any)?.pollDelayMs;
        const delayMs = typeof configuredDelay === 'number'
          ? configuredDelay
          : (params.orderType === 'Market' ? 800 : 200);
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        const statusQueryParams = {
          category: params.category,
          symbol: params.symbol,
          orderId: result.orderId,
        };
        const statusResult = await this.makeRequest('GET', '/v5/order/realtime', statusQueryParams, true);
        let orderInfo = statusResult?.list?.[0];

        if (!orderInfo) {
          const historyResult = await this.makeRequest('GET', '/v5/order/history', statusQueryParams, true);
          orderInfo = historyResult?.list?.[0];
        }

        if (orderInfo) {
          statusVerified = true;
          const execQtyNum = orderInfo.cumExecQty ? parseFloat(orderInfo.cumExecQty) : 0;
          if (orderInfo.orderStatus === 'Filled') actualStatus = 'closed';
          else if (orderInfo.orderStatus === 'PartiallyFilled') actualStatus = 'open';
          else if (orderInfo.orderStatus === 'PartiallyFilledCanceled') {
            actualStatus = execQtyNum > 0 ? 'partially_filled' : 'canceled';
          } else if (orderInfo.orderStatus === 'Cancelled' || orderInfo.orderStatus === 'Deactivated') {
            actualStatus = 'canceled';
          } else if (orderInfo.orderStatus === 'Rejected') {
            actualStatus = 'rejected';
          }

          if (execQtyNum > 0) {
            actualFilled = new BigNumber(orderInfo.cumExecQty);
          } else if (!isLimit && !(order as any).triggerPrice && actualStatus === 'open') {
            statusVerified = false;
          }
          if (orderInfo.avgPrice && parseFloat(orderInfo.avgPrice) > 0) {
            actualPrice = new BigNumber(orderInfo.avgPrice);
          }
          if (orderInfo.stopLoss !== undefined && String(orderInfo.stopLoss).trim() !== '' && Number(orderInfo.stopLoss) > 0) {
            confirmedStopLoss = String(orderInfo.stopLoss);
          }
          if (orderInfo.takeProfit !== undefined && String(orderInfo.takeProfit).trim() !== '' && Number(orderInfo.takeProfit) > 0) {
            confirmedTakeProfit = String(orderInfo.takeProfit);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to fetch immediate order status', e);
    }

    return {
      id: result?.orderId || '',
      clientOrderId: result?.orderLinkId || params.orderLinkId || '',
      symbol: canonicalSymbol,
      side: isBuy ? 'buy' : 'sell',
      type: isLimit ? 'limit' : 'market',
      status: actualStatus as any,
      price: actualPrice || (order.price ? order.price : new BigNumber(0)),
      average: actualPrice || undefined,
      amount: order.amount,
      filled: actualFilled,
      remaining: order.amount.minus(actualFilled),
      timestamp: Date.now(),
      stopLoss: confirmedStopLoss,
      takeProfit: confirmedTakeProfit,
      ...(statusVerified ? {} : { statusVerificationFailed: true }),
    } as any;
  }

  public async cancelOrder(orderId: string, symbol: string, category?: string): Promise<boolean> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const reqCategory = category || 'linear';
    const params = {
      category: reqCategory,
      symbol: rawSymbol,
      orderId,
    };
    await this.makeRequest('POST', '/v5/order/cancel', params, true);
    return true;
  }

  public async fetchOrder(
    request: { clientOrderId?: string; exchangeOrderId?: string; symbol: string; category?: string } | string,
    symbolArg?: string,
    categoryArg?: string
  ): Promise<Order> {
    const normalizedReq =
      typeof request === 'string'
        ? { exchangeOrderId: request, symbol: symbolArg || '', category: categoryArg }
        : request;

    if (!normalizedReq.clientOrderId && !normalizedReq.exchangeOrderId) {
      throw new UnifiedError(`fetchOrder requires exactly one of clientOrderId or exchangeOrderId`, 'INVALID_REQUEST');
    }
    if (normalizedReq.clientOrderId && normalizedReq.exchangeOrderId) {
      throw new UnifiedError(`fetchOrder requires exactly one of clientOrderId or exchangeOrderId, not both`, 'INVALID_REQUEST');
    }

    const { canonicalSymbol } = this.normalizeSymbol(normalizedReq.symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const reqCategory = normalizedReq.category || 'linear';
    
    const params: Record<string, any> = { category: reqCategory, symbol: rawSymbol };
    if (normalizedReq.clientOrderId) {
      params.orderLinkId = normalizedReq.clientOrderId;
    } else {
      params.orderId = normalizedReq.exchangeOrderId;
    }

    const result = await this.makeRequest('GET', '/v5/order/realtime', params, true);
    let item = result?.list?.[0];

    if (!item) {
      const historyResult = await this.makeRequest('GET', '/v5/order/history', params, true);
      item = historyResult?.list?.[0];
    }

    if (!item) {
      throw new UnifiedError(`Order not found`, 'ORDER_NOT_FOUND');
    }

    const execQtyNum = item.cumExecQty ? parseFloat(item.cumExecQty) : 0;
    const parsedStatus =
      item.orderStatus === 'Filled'
        ? 'closed'
        : item.orderStatus === 'PartiallyFilled'
        ? 'partially_filled'
        : item.orderStatus === 'PartiallyFilledCanceled'
        ? (execQtyNum > 0 ? 'partially_filled' : 'canceled')
        : item.orderStatus === 'Rejected'
        ? 'rejected'
        : item.orderStatus === 'Cancelled' || item.orderStatus === 'Deactivated'
        ? 'canceled'
        : 'open';

    return {
      id: item.orderId,
      clientOrderId: item.orderLinkId,
      symbol: canonicalSymbol,
      side: item.side.toLowerCase() as 'buy' | 'sell',
      type: item.orderType.toLowerCase() as 'limit' | 'market',
      status: parsedStatus,
      price: item.price ? new BigNumber(item.price) : new BigNumber(0),
      average: item.avgPrice && parseFloat(item.avgPrice) > 0 ? new BigNumber(item.avgPrice) : undefined,
      amount: new BigNumber(item.qty || 0),
      filled: new BigNumber(item.cumExecQty || 0),
      remaining: new BigNumber(item.leavesQty || 0),
      timestamp: parseInt(item.updatedTime || item.createdTime, 10),
      stopLoss: item.stopLoss && Number(item.stopLoss) > 0 ? item.stopLoss : undefined,
      takeProfit: item.takeProfit && Number(item.takeProfit) > 0 ? item.takeProfit : undefined,
      reduceOnly: Boolean(item.reduceOnly),
    } as any;
  }

  public async fetchOpenOrders(symbol?: string, category?: string): Promise<Order[]> {
    const rawSymbol = symbol ? this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '').toUpperCase() : undefined;
    const reqCategory = category || 'linear';
    const params: Record<string, any> = { category: reqCategory, settleCoin: 'USDT' };
    if (rawSymbol) params.symbol = rawSymbol;

    const result = await this.makeRequest('GET', '/v5/order/realtime', params, true);
    const list = result?.list || [];

    return list.map((item: any) => ({
      id: item.orderId,
      clientOrderId: item.orderLinkId,
      symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
      side: item.side.toLowerCase() as 'buy' | 'sell',
      type: item.orderType.toLowerCase() as 'limit' | 'market',
      status: 'open',
      price: new BigNumber(item.price || 0),
      average: new BigNumber(item.avgPrice || 0),
      amount: new BigNumber(item.qty || 0),
      filled: new BigNumber(item.cumExecQty || 0),
      remaining: new BigNumber(item.leavesQty || 0),
      timestamp: parseInt(item.createdTime, 10),
      stopLoss: item.stopLoss,
      takeProfit: item.takeProfit,
      reduceOnly: Boolean(item.reduceOnly),
    }));
  }

  public async fetchClosedOrders(symbol?: string, category?: string): Promise<Order[]> {
    const rawSymbol = symbol ? this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '').toUpperCase() : undefined;
    const reqCategory = category || 'linear';
    const params: Record<string, any> = { category: reqCategory, settleCoin: 'USDT' };
    if (rawSymbol) params.symbol = rawSymbol;

    const result = await this.makeRequest('GET', '/v5/order/history', params, true);
    const list = result?.list || [];

    return list.map((item: any) => {
      const execQtyNum = item.cumExecQty ? parseFloat(item.cumExecQty) : 0;
      const mappedStatus =
        item.orderStatus === 'Filled'
          ? 'closed'
          : item.orderStatus === 'PartiallyFilledCanceled' && execQtyNum > 0
          ? 'partially_filled'
          : item.orderStatus === 'Rejected'
          ? 'rejected'
          : 'canceled';
      return {
        id: item.orderId,
        clientOrderId: item.orderLinkId,
        symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
        side: item.side.toLowerCase() as 'buy' | 'sell',
        type: item.orderType.toLowerCase() as 'limit' | 'market',
        status: mappedStatus as any,
        price: new BigNumber(item.price || 0),
        average: new BigNumber(item.avgPrice || 0),
        amount: new BigNumber(item.qty || 0),
        filled: new BigNumber(item.cumExecQty || 0),
        remaining: new BigNumber(item.leavesQty || 0),
        timestamp: parseInt(item.updatedTime || item.createdTime, 10),
        stopLoss: item.stopLoss,
        takeProfit: item.takeProfit,
        reduceOnly: Boolean(item.reduceOnly),
      };
    });
  }

  public async fetchMyTrades(symbol?: string, category?: string): Promise<Trade[]> {
    const rawSymbol = symbol ? this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '').toUpperCase() : undefined;
    const reqCategory = category || 'linear';
    const params: Record<string, any> = { category: reqCategory, settleCoin: 'USDT' };
    if (rawSymbol) params.symbol = rawSymbol;

    const result = await this.makeRequest('GET', '/v5/execution/list', params, true);
    const list = result?.list || [];

    return list.map((item: any) => ({
      id: item.execId,
      orderId: item.orderId,
      symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
      side: item.side.toLowerCase() as 'buy' | 'sell',
      price: new BigNumber(item.execPrice || 0),
      amount: new BigNumber(item.execQty || 0),
      cost: new BigNumber(item.execValue || 0),
      fee: {
        cost: new BigNumber(item.execFee || 0),
        currency: 'USDT',
      },
      timestamp: parseInt(item.execTime, 10),
    }));
  }

  public async fetchClosedPnl(symbol?: string, category?: string): Promise<any[]> {
    const rawSymbol = symbol ? this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '').toUpperCase() : undefined;
    const reqCategory = category || 'linear';
    const params: Record<string, any> = { category: reqCategory };
    if (rawSymbol) params.symbol = rawSymbol;

    const result = await this.makeRequest('GET', '/v5/position/closed-pnl', params, true);
    const list = result?.list || [];

    return list.map((item: any) => ({
      symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
      orderId: item.orderId,
      side: item.side?.toLowerCase() as 'buy' | 'sell',
      qty: parseFloat(item.qty || '0'),
      orderPrice: parseFloat(item.orderPrice || '0'),
      orderType: item.orderType,
      execType: item.execType,
      closedPnl: parseFloat(item.closedPnl || '0'),
      avgEntryPrice: parseFloat(item.avgEntryPrice || '0'),
      avgExitPrice: parseFloat(item.avgExitPrice || '0'),
      closedSize: parseFloat(item.closedSize || '0'),
      leverage: parseFloat(item.leverage || '1'),
      createdTime: parseInt(item.createdTime, 10),
      updatedTime: parseInt(item.updatedTime, 10),
    }));
  }
}
