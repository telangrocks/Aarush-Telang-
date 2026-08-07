import { IExchangeProvider } from '../../../exchanges/IExchangeProvider';
import { IExchangeAdapter } from '../types';
import { ProviderConfig } from '../../../exchanges/models/ConnectionConfig';
import { Market, Balance, Ticker, Position, Order, OrderRequest, Trade, OcoOrderRequest, OcoOrderResponse } from '../../../exchanges/models/NormalizedDomain';
import { ExchangeCapabilities, DEFAULT_CAPABILITIES } from '../../../domain/capabilities/ExchangeCapabilities';
import { UnifiedError } from '../../../exchanges/models/UnifiedError';
import { StructuredLogger } from '../../telemetry/Telemetry';

export abstract class BaseExchangeAdapter implements IExchangeProvider, IExchangeAdapter {
  abstract readonly exchangeId: string;
  readonly capabilities: ExchangeCapabilities = DEFAULT_CAPABILITIES;
  protected config!: ProviderConfig;
  protected logger = new StructuredLogger();
  protected defaultTimeoutMs = 10000;

  public async connect(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  public async disconnect(): Promise<void> {}

  /**
   * Protected base symbol normalization logic (Fix L7).
   */
  protected normalizeSymbolBase(symbol: string): { base: string; quote: string; canonicalSymbol: string } {
    if (!symbol) {
      return { base: '', quote: '', canonicalSymbol: '' };
    }
    const clean = symbol.trim().toUpperCase();
    if (clean.includes('/')) {
      const [base, quote] = clean.split('/');
      return { base, quote, canonicalSymbol: `${base}/${quote}` };
    }
    if (clean.includes('-')) {
      const [base, quote] = clean.split('-');
      return { base, quote, canonicalSymbol: `${base}/${quote}` };
    }
    if (clean.includes('_')) {
      const [base, quote] = clean.split('_');
      return { base, quote, canonicalSymbol: `${base}/${quote}` };
    }
    const quoteAssets = ['USDT', 'USDC', 'BUSD', 'USD', 'BTC', 'ETH', 'EUR', 'INR'];
    for (const q of quoteAssets) {
      if (clean.endsWith(q) && clean.length > q.length) {
        const base = clean.slice(0, clean.length - q.length);
        return { base, quote: q, canonicalSymbol: `${base}/${q}` };
      }
    }
    return { base: clean, quote: '', canonicalSymbol: clean };
  }

  /**
   * Standardized symbol parser returning base, quote, and canonical symbol (e.g. BTC/USDT).
   */
  public normalizeSymbol(symbol: string): { base: string; quote: string; canonicalSymbol: string } {
    return this.normalizeSymbolBase(symbol);
  }

  /**
   * Helper method for performing HTTP requests with a configurable timeout (Fix H3).
   */
  protected async fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = this.defaultTimeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await globalThis.fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } catch (err: any) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError' || (err instanceof DOMException && err.name === 'AbortError') || controller.signal.aborted) {
        throw new UnifiedError('Request timed out after 10000ms.', 'EXCHANGE_TIMEOUT');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  abstract fetchMarkets(): Promise<Market[]>;
  abstract fetchBalance(): Promise<Balance[]>;
  abstract fetchTicker(symbol: string): Promise<Ticker>;
  abstract fetchKlines(symbol: string, interval: string, limit?: number): Promise<any[]>;
  abstract fetchPositions(): Promise<Position[]>;

  abstract createOrder(order: OrderRequest): Promise<Order>;
  abstract cancelOrder(orderId: string, symbol: string): Promise<boolean>;

  public supportsOco(): boolean {
    return this.capabilities.supportsOco;
  }

  public async createOcoOrder(_order: OcoOrderRequest): Promise<OcoOrderResponse> {
    throw new UnifiedError(`OCO orders not supported on exchange ${this.exchangeId}`, 'UNSUPPORTED_OPERATION');
  }

  abstract fetchOrder(orderId: string, symbol: string): Promise<Order>;
  abstract fetchOpenOrders(symbol?: string): Promise<Order[]>;
  abstract fetchClosedOrders(symbol?: string): Promise<Order[]>;
  abstract fetchMyTrades(symbol?: string): Promise<Trade[]>;
}
