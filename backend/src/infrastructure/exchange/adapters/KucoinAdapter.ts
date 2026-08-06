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
    if (config.environment === 'testnet' || config.environment === 'Testing') {
      throw new UnifiedError('KuCoin Sandbox is officially deprecated and offline.', 'UNSUPPORTED_OPERATION');
    }
    await super.connect(config);
  }

  public async fetchBalance(): Promise<Balance[]> {
    const cleanKey = (this.config.apiKey || '').trim();
    const cleanSec = (this.config.secret || '').trim();
    const cleanPass = (this.config.password || this.config.passphrase || '').trim();

    if (!cleanKey || !cleanSec || !cleanPass) {
      throw new UnifiedError('Missing required KuCoin credentials (API Key, Secret, or Passphrase).', 'MISSING_REQUIRED_CREDENTIALS');
    }

    const ts = Date.now().toString();
    const endpoint = '/api/v1/accounts?type=trade';
    const method = 'GET';
    const passHmac = await WebCryptoSigner.hmacSha256Base64(cleanSec, cleanPass);
    const strToSign = ts + method + endpoint;
    const sig = await WebCryptoSigner.hmacSha256Base64(cleanSec, strToSign);

    const headers = {
      'KC-API-KEY': cleanKey,
      'KC-API-SIGN': sig,
      'KC-API-TIMESTAMP': ts,
      'KC-API-PASSPHRASE': passHmac,
      'KC-API-KEY-VERSION': '2',
      'User-Agent': 'CryptoPulse/1.0',
    };

    const res = await globalThis.fetch(`https://openapi-v2.kucoin.com${endpoint}`, { method, headers });
    const errText = await res.text();

    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    let json: any = {};
    try {
      json = JSON.parse(errText);
    } catch (_) {
      // Ignored
    }

    if (json.code !== '200000' || !Array.isArray(json.data)) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    const balances: Balance[] = [];
    for (const b of json.data) {
      const free = new BigNumber(b.available || 0);
      const locked = new BigNumber(b.holds || 0);
      balances.push({
        currency: b.currency,
        free,
        used: locked,
        total: free.plus(locked),
      });
    }
    return balances;
  }

  public async fetchTicker(symbol: string): Promise<Ticker> {
    const rawSymbol = symbol.replace('/', '-').toUpperCase();
    const res = await globalThis.fetch(`https://openapi-v2.kucoin.com/api/v1/market/orderbook/level1?symbol=${rawSymbol}`);
    const errText = await res.text();

    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    let json: any = {};
    try {
      json = JSON.parse(errText);
    } catch (_) {
      // Ignored
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
      volume: new BigNumber(json.data.size || 1000),
      quoteVolume: px.multipliedBy(1000),
    };
  }

  public async fetchKlines(symbol: string, interval: string, limit: number): Promise<any[]> {
    const rawSymbol = symbol.replace('/', '-').toUpperCase();
    const kcType = interval === '1m' ? '1min' : interval === '5m' ? '5min' : interval === '15m' ? '15min' : interval === '1h' ? '1hour' : '1min';
    const res = await globalThis.fetch(`https://openapi-v2.kucoin.com/api/v1/market/candles?symbol=${rawSymbol}&type=${kcType}`);
    const errText = await res.text();

    if (!res.ok) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    let json: any = {};
    try {
      json = JSON.parse(errText);
    } catch (_) {
      // Ignored
    }

    if (json.code !== '200000' || !Array.isArray(json.data)) {
      const classified = ExchangeErrorClassifier.getInstance().classifyResponse('kucoin', res.status, res.headers, errText);
      throw new UnifiedError(classified.friendlyMessage, classified.code);
    }

    return json.data.slice(0, limit).map((k: any) => ({
      openTime: parseInt(k[0]) * 1000,
      open: parseFloat(k[1]),
      close: parseFloat(k[2]),
      high: parseFloat(k[3]),
      low: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  public async fetchMarkets(): Promise<Market[]> {
    return [
      {
        id: 'BTC-USDT',
        symbol: 'BTC/USDT',
        base: 'BTC',
        quote: 'USDT',
        active: true,
        precision: { price: 0.01, amount: 0.00001 },
        limits: {
          amount: { min: new BigNumber(0.0001) },
          price: { min: new BigNumber(0.01) },
          cost: { min: new BigNumber(10) },
        },
      },
    ];
  }

  public async fetchPositions(): Promise<Position[]> {
    return [];
  }

  public async createOrder(_order: OrderRequest): Promise<Order> {
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
