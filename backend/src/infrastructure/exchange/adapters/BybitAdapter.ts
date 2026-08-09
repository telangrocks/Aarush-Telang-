import { BaseExchangeAdapter } from './BaseExchangeAdapter';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade } from '../../../exchanges/models/NormalizedDomain';
import { ExchangeCapabilities } from '../../../domain/capabilities/ExchangeCapabilities';
import { WebCryptoSigner } from '../../crypto/WebCryptoSigner';
import { UnifiedError } from '../../../exchanges/models/UnifiedError';
import { ExchangeErrorClassifier } from '../../../exchanges/ExchangeErrorClassifier';
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
    const env = (this.config?.environment || '').toString().toLowerCase();
    if (env === 'demo') {
      return 'https://api-demo.bybit.com';
    }
    const isTestnet = env === 'testnet' || env === 'testing' || env === 'sandbox';
    if (isTestnet) {
      if (process.env.BYBIT_TESTNET_URL) {
        return process.env.BYBIT_TESTNET_URL.replace(/\/$/, '');
      }
      return 'https://api-testnet.bybit.com';
    }
    return 'https://api.bybit.com';
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

  private async makeRequest(method: 'GET' | 'POST', path: string, params: Record<string, any> = {}, isPrivate = false): Promise<any> {
    const startTime = Date.now();
    const host = this.getHost();
    const cleanKey = (this.config?.apiKey || '').trim();
    const cleanSec = (this.config?.secret || '').trim();

    if (isPrivate && (!cleanKey || !cleanSec)) {
      throw new UnifiedError('Missing required exchange credentials (API Key or Secret).', 'MISSING_REQUIRED_CREDENTIALS');
    }

    const ts = Date.now().toString();
    const recvWindow = '5000';
    let url = `${host}${path}`;
    let bodyStr = '';
    let queryString = '';

    if (method === 'GET') {
      const keys = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null);
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
    }

    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    let status = 0;
    let errText = '';
    try {
      const res = await this.fetchWithTimeout(url, {
        method,
        headers,
        body: method === 'POST' ? bodyStr : undefined,
      });

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
        const classified = ExchangeErrorClassifier.getInstance().classifyResponse('bybit', status, res.headers, errText);
        throw new UnifiedError(classified.friendlyMessage, classified.code);
      }

      let json: any = {};
      try {
        json = JSON.parse(errText);
      } catch (_) {
        const classified = ExchangeErrorClassifier.getInstance().classifyResponse('bybit', status, res.headers, errText);
        throw new UnifiedError(classified.friendlyMessage, classified.code);
      }

      if (json.retCode !== 0 && json.ret_code !== 0) {
        const classified = ExchangeErrorClassifier.getInstance().classifyResponse('bybit', status, res.headers, errText);
        throw new UnifiedError(classified.friendlyMessage || json.retMsg || json.ret_msg || 'Exchange returned error', classified.code);
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

  public async fetchBalance(): Promise<Balance[]> {
    let result: any;
    try {
      result = await this.makeRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, true);
    } catch (err) {
      result = await this.makeRequest('GET', '/v5/account/wallet-balance', { accountType: 'SPOT' }, true);
    }

    const balances: Balance[] = [];
    const list = result?.list || [];
    for (const acc of list) {
      const coins = acc.coin || [];
      for (const c of coins) {
        const free = new BigNumber(c.availableToWithdraw || c.free || c.equity || 0);
        const locked = new BigNumber(c.locked || c.used || 0);
        const total = new BigNumber(c.walletBalance || c.equity || free.plus(locked));
        balances.push({
          currency: c.coin,
          free,
          used: locked,
          total,
        });
      }
    }
    return balances;
  }

  public async fetchTicker(symbol: string): Promise<Ticker> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const startTime = Date.now();
    const url = `${this.getHost()}/v5/market/tickers?category=linear&symbol=${rawSymbol}`;

    this.logger.info('[BybitAdapter] Outbound fetchTicker', { symbol: canonicalSymbol, rawSymbol, url });

    let result: any;
    try {
      result = await this.makeRequest('GET', '/v5/market/tickers', { category: 'linear', symbol: rawSymbol }, false);
    } catch (_) {
      result = await this.makeRequest('GET', '/v5/market/tickers', { category: 'spot', symbol: rawSymbol }, false);
    }

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
    };
  }

  public async fetchKlines(symbol: string, interval: string, limit = 200): Promise<any[]> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const bybitInterval = this.normalizeInterval(interval);
    const tfMs = CandleValidator.timeframeToMs(interval);
    const startTime = Date.now();
    const url = `${this.getHost()}/v5/market/kline?category=linear&symbol=${rawSymbol}&interval=${bybitInterval}&limit=${limit}`;

    this.logger.info('[BybitAdapter] Outbound fetchKlines', { symbol: canonicalSymbol, rawSymbol, interval, limit, url });

    let result: any;
    try {
      result = await this.makeRequest('GET', '/v5/market/kline', { category: 'linear', symbol: rawSymbol, interval: bybitInterval, limit }, false);
    } catch (_) {
      result = await this.makeRequest('GET', '/v5/market/kline', { category: 'spot', symbol: rawSymbol, interval: bybitInterval, limit }, false);
    }

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

  public async fetchMarkets(): Promise<Market[]> {
    let result: any;
    try {
      result = await this.makeRequest('GET', '/v5/market/instruments-info', { category: 'linear' }, false);
    } catch (_) {
      result = await this.makeRequest('GET', '/v5/market/instruments-info', { category: 'spot' }, false);
    }

    const list = result?.list || [];
    const markets: Market[] = [];
    for (const item of list) {
      const symbol = `${item.baseCoin}/${item.quoteCoin}`;
      const priceStep = parseFloat(item.priceFilter?.tickSize || '0.01');
      const amountStep = parseFloat(item.lotSizeFilter?.qtyStep || '0.001');
      const minAmount = parseFloat(item.lotSizeFilter?.minOrderQty || '0.001');
      const minPrice = parseFloat(item.priceFilter?.minPrice || '0.01');
      const minNotional = parseFloat(item.lotSizeFilter?.minNotionalValue || '5.0');

      markets.push({
        id: item.symbol,
        symbol,
        base: item.baseCoin,
        quote: item.quoteCoin,
        active: item.status === 'Trading',
        precision: { price: priceStep, amount: amountStep },
        limits: {
          amount: { min: new BigNumber(minAmount) },
          price: { min: new BigNumber(minPrice) },
          cost: { min: new BigNumber(minNotional) },
        },
      });
    }
    return markets;
  }

  public async fetchPositions(): Promise<Position[]> {
    const result = await this.makeRequest('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }, true);
    const list = result?.list || [];
    const positions: Position[] = [];

    for (const p of list) {
      const size = new BigNumber(p.size || 0);
      if (size.isZero()) continue;

      const { canonicalSymbol } = this.normalizeSymbol(p.symbol);
      positions.push({
        symbol: canonicalSymbol,
        side: p.side === 'Buy' ? 'long' : 'short',
        entryPrice: new BigNumber(p.avgPrice || p.entryPrice || 0),
        markPrice: new BigNumber(p.markPrice || 0),
        size: size,
        unrealizedPnl: new BigNumber(p.unrealisedPnl || 0),
        leverage: parseFloat(p.leverage || '1'),
      });
    }
    return positions;
  }

  public async createOrder(order: OrderRequest): Promise<Order> {
    const { canonicalSymbol } = this.normalizeSymbol(order.symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const isBuy = order.side.toLowerCase() === 'buy';
    const isLimit = order.type.toLowerCase() === 'limit';
    
    const qtyBN = new BigNumber(order.amount);
    const qtyStr = qtyBN.toFixed(8).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

    const category = ((this.config?.environment as string) === 'futures' || order.symbol.includes(':')) ? 'linear' : 'spot';

    const params: Record<string, any> = {
      category,
      symbol: rawSymbol,
      side: isBuy ? 'Buy' : 'Sell',
      orderType: isLimit ? 'Limit' : 'Market',
      qty: qtyStr,
      timeInForce: 'GTC',
    };

    if (order.clientOrderId) {
      const cleanId = order.clientOrderId.replace(/[^a-zA-Z0-9-_]/g, '');
      params.orderLinkId = cleanId.length > 36 ? cleanId.slice(-36) : cleanId;
    }

    if (isLimit && order.price) {
      const priceBN = new BigNumber(order.price);
      params.price = priceBN.toFixed(8).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
    }

    if ((order as any).takeProfit) {
      const tpBN = new BigNumber((order as any).takeProfit);
      params.takeProfit = tpBN.toFixed(8).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
    }

    if ((order as any).stopLoss) {
      const slBN = new BigNumber((order as any).stopLoss);
      params.stopLoss = slBN.toFixed(8).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
    }

    let result: any;
    try {
      result = await this.makeRequest('POST', '/v5/order/create', params, true);
    } catch (err: any) {
      // Fallback to linear category if spot returns invalid category
      if (err?.message?.includes('category') || err?.message?.includes('10001')) {
        params.category = 'linear';
        result = await this.makeRequest('POST', '/v5/order/create', params, true);
      } else {
        throw err;
      }
    }

    return {
      id: result?.orderId || '',
      clientOrderId: result?.orderLinkId || params.orderLinkId || '',
      symbol: canonicalSymbol,
      side: isBuy ? 'buy' : 'sell',
      type: isLimit ? 'limit' : 'market',
      status: 'open',
      price: order.price || new BigNumber(0),
      amount: order.amount,
      filled: new BigNumber(0),
      remaining: order.amount,
      timestamp: Date.now(),
    };
  }

  public async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const params = {
      category: 'linear',
      symbol: rawSymbol,
      orderId,
    };
    await this.makeRequest('POST', '/v5/order/cancel', params, true);
    return true;
  }

  public async fetchOrder(orderId: string, symbol: string): Promise<Order> {
    const { canonicalSymbol } = this.normalizeSymbol(symbol);
    const rawSymbol = canonicalSymbol.replace('/', '').toUpperCase();
    const result = await this.makeRequest('GET', '/v5/order/realtime', { category: 'linear', symbol: rawSymbol, orderId }, true);
    const item = result?.list?.[0];

    if (!item) {
      throw new UnifiedError(`Order ${orderId} not found`, 'EXCHANGE_NOT_REACHABLE');
    }

    return {
      id: item.orderId,
      clientOrderId: item.orderLinkId,
      symbol: canonicalSymbol,
      side: item.side.toLowerCase() as 'buy' | 'sell',
      type: item.orderType.toLowerCase() as 'limit' | 'market',
      status: item.orderStatus === 'Filled' ? 'closed' : item.orderStatus === 'Cancelled' ? 'canceled' : 'open',
      price: new BigNumber(item.price || 0),
      amount: new BigNumber(item.qty || 0),
      filled: new BigNumber(item.cumExecQty || 0),
      remaining: new BigNumber(item.leavesQty || 0),
      timestamp: parseInt(item.createdTime, 10),
    };
  }

  public async fetchOpenOrders(symbol?: string): Promise<Order[]> {
    const rawSymbol = symbol ? this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '').toUpperCase() : undefined;
    const params: Record<string, any> = { category: 'linear', settleCoin: 'USDT' };
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
      amount: new BigNumber(item.qty || 0),
      filled: new BigNumber(item.cumExecQty || 0),
      remaining: new BigNumber(item.leavesQty || 0),
      timestamp: parseInt(item.createdTime, 10),
    }));
  }

  public async fetchClosedOrders(symbol?: string): Promise<Order[]> {
    const rawSymbol = symbol ? this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '').toUpperCase() : undefined;
    const params: Record<string, any> = { category: 'linear', settleCoin: 'USDT' };
    if (rawSymbol) params.symbol = rawSymbol;

    const result = await this.makeRequest('GET', '/v5/order/history', params, true);
    const list = result?.list || [];

    return list.map((item: any) => ({
      id: item.orderId,
      clientOrderId: item.orderLinkId,
      symbol: this.normalizeSymbol(item.symbol).canonicalSymbol,
      side: item.side.toLowerCase() as 'buy' | 'sell',
      type: item.orderType.toLowerCase() as 'limit' | 'market',
      status: item.orderStatus === 'Filled' ? 'closed' : 'canceled',
      price: new BigNumber(item.price || 0),
      amount: new BigNumber(item.qty || 0),
      filled: new BigNumber(item.cumExecQty || 0),
      remaining: new BigNumber(item.leavesQty || 0),
      timestamp: parseInt(item.createdTime, 10),
    }));
  }

  public async fetchMyTrades(symbol?: string): Promise<Trade[]> {
    const rawSymbol = symbol ? this.normalizeSymbol(symbol).canonicalSymbol.replace('/', '').toUpperCase() : undefined;
    const params: Record<string, any> = { category: 'linear', settleCoin: 'USDT' };
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
}
