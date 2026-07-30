import { IExchangeProvider } from './IExchangeProvider';
import { ProviderFactory } from './ProviderFactory';
import { ProviderConfig } from './models/ConnectionConfig';
import { Order, OrderRequest } from './models/NormalizedDomain';
// NOTE: crypto.randomUUID() is available as a Web Crypto API global in Cloudflare
// Workers — no import needed. Importing 'crypto' from Node would require
// nodejs_compat but adds unnecessary bundling complexity.
import { UnifiedError } from './models/UnifiedError';

export class ExchangeManager {
  private static providerCache = new Map<string, IExchangeProvider>();

  /**
   * Retrieves a connected Exchange Provider. 
   * Providers are cached by a deterministic hash of their credentials 
   * to reuse connections and market data caches across requests.
   */
  public static async getProvider(exchangeId: string, config: ProviderConfig): Promise<IExchangeProvider> {
    const cacheKey = `${exchangeId}:${config.environment}:${config.apiKey}:${config.secret || ''}`;
    
    if (this.providerCache.has(cacheKey)) {
      return this.providerCache.get(cacheKey)!;
    }

    const provider = ProviderFactory.create(exchangeId);
    
    try {
      // Automatic retry backoff for initial connections
      await this.withRetry(async () => {
        await provider.connect(config);
      }, 3);

      this.providerCache.set(cacheKey, provider);
      return provider;
    } catch (error) {
      try {
        await provider.disconnect();
      } catch (_) {}
      this.providerCache.delete(cacheKey);
      throw error;
    }
  }

  /**
   * Creates a fresh, uncached Exchange Provider instance for validation flows.
   * Credentials used during validation are never read from or saved to the cache.
   */
  public static async createUncachedProvider(exchangeId: string, config: ProviderConfig): Promise<IExchangeProvider> {
    const provider = ProviderFactory.create(exchangeId);
    await this.withRetry(async () => {
      await provider.connect(config);
    }, 3);
    return provider;
  }

  /**
   * Disconnects and removes a provider from the active cache.
   */
  public static async disconnectProvider(exchangeId: string, config: ProviderConfig): Promise<void> {
    const cacheKey = `${exchangeId}:${config.environment}:${config.apiKey}:${config.secret || ''}`;
    const provider = this.providerCache.get(cacheKey);
    
    if (provider) {
      await provider.disconnect();
      this.providerCache.delete(cacheKey);
    }
  }

  /**
   * Safely executes an order placement with strict idempotency enforcement.
   * Ensures a clientOrderId is always injected.
   */
  public static async executeIdempotentOrder(provider: IExchangeProvider, request: OrderRequest): Promise<Order> {
    const idempotentRequest = { ...request };
    
    if (!idempotentRequest.clientOrderId) {
      idempotentRequest.clientOrderId = crypto.randomUUID();
    }

    return this.withRetry(async () => {
      return provider.createOrder(idempotentRequest);
    }, 3);
  }

  /**
   * Safely executes an OCO order placement with strict idempotency enforcement.
   */
  public static async executeIdempotentOcoOrder(
    provider: IExchangeProvider,
    request: import('./models/NormalizedDomain').OcoOrderRequest
  ): Promise<import('./models/NormalizedDomain').OcoOrderResponse> {
    const idempotentRequest = { ...request };
    if (!idempotentRequest.listClientOrderId) {
      idempotentRequest.listClientOrderId = `oco_${crypto.randomUUID()}`;
    }

    return this.withRetry(async () => {
      return provider.createOcoOrder(idempotentRequest);
    }, 3);
  }

  /**
   * Generic retry wrapper with exponential backoff (250ms, 500ms, 1000ms).
   */
  private static async withRetry<T>(operation: () => Promise<T>, maxRetries: number = 3): Promise<T> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await operation();
      } catch (error: any) {
        attempt++;
        
        // Do not retry on validation, authentication, or insufficient funds errors
        if (error instanceof UnifiedError) {
          if (['AUTHENTICATION_FAILED', 'INSUFFICIENT_FUNDS', 'INVALID_ORDER', 'UNSUPPORTED_EXCHANGE'].includes(error.mappedInternalErrorCode)) {
            throw error;
          }
        }

        if (attempt >= maxRetries) {
          throw error;
        }

        // Exponential backoff: 250ms, 500ms, 1000ms
        const delay = Math.min(250 * Math.pow(2, attempt - 1), 1000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Unreachable');
  }
}
