import { IExchangeProvider } from './IExchangeProvider';
import { ProviderConfig } from './models/ConnectionConfig';
import { Order, OrderRequest, OcoOrderRequest, OcoOrderResponse } from './models/NormalizedDomain';
import { ExchangeRegistry } from '../infrastructure/exchange/registry/ExchangeRegistry';
import { BaseExchangeAdapter } from '../infrastructure/exchange/adapters/BaseExchangeAdapter';
import { BybitAdapter } from '../infrastructure/exchange/adapters/BybitAdapter';
import { ProviderPool } from '../infrastructure/cache/ProviderPool';
import { ExchangeOrchestrator } from '../infrastructure/orchestrator/ExchangeOrchestrator';
import { Result } from '../domain/types/Result';
import { WebCryptoSigner } from '../infrastructure/crypto/WebCryptoSigner';
import { UnifiedError } from './models/UnifiedError';
import { ExchangeRoutingResolver } from './routing/ExchangeRoutingResolver';

// Bootstrap registration of Bybit adapter
ExchangeRegistry.register({ exchangeId: 'bybit', factory: () => new BybitAdapter() });

export class ExchangeManager {
  /**
   * Note (Fix EC-M1): ProviderPool and ExchangeOrchestrator are intentionally static for
   * single-tenant Worker execution where shared caching and global telemetry are desired.
   */
  private static pool = new ProviderPool(50, 15 * 60 * 1000);
  private static orchestrator = new ExchangeOrchestrator();

  private static async getHashedCacheKey(exchangeId: string, config: ProviderConfig): Promise<string> {
    const cleanKey = (config.apiKey || '').trim();
    const cleanSec = (config.secret || '').trim();
    const cleanPass = (config.passphrase || config.password || '').trim();

    const rawCreds = `${cleanKey}:${cleanSec}:${cleanPass}`;
    const credHash = rawCreds !== '::' ? await WebCryptoSigner.hashSha256(rawCreds) : 'public';

    const canonicalEnv = ExchangeRoutingResolver.getCanonicalEnvironment(config.environment);
    const canonicalReg = ExchangeRoutingResolver.getCanonicalRegion(config.region);
    const product = config.product || 'spot';

    return `${exchangeId.toLowerCase()}:${product}:${canonicalEnv}:${canonicalReg}:${credHash}`;
  }

  /**
   * Evicts a user's cached exchange provider from the ProviderPool upon credential invalidation.
   */
  public static async invalidateUserProvider(exchangeId: string, config: ProviderConfig): Promise<void> {
    try {
      const cacheKey = await this.getHashedCacheKey(exchangeId, config);
      this.pool.delete(cacheKey);
    } catch (e) {
      console.warn(`[ExchangeManager] Failed to invalidate provider for ${exchangeId}:`, e);
    }
  }

  /**
   * Retrieves a connected Exchange Provider from the bounded ProviderPool.
   */
  public static async getProvider(exchangeId: string, config: ProviderConfig): Promise<IExchangeProvider> {
    // Fix EC-M2: Hash credentials before generating cache key
    const cacheKey = await this.getHashedCacheKey(exchangeId, config);

    const cached = this.pool.get(cacheKey);
    if (cached) {
      return cached;
    }

    const provider = ExchangeRegistry.create(exchangeId);
    // Fix EC-C1 & EC-C2: Check Result return from orchestrator.execute()
    const res = await this.orchestrator.execute(provider, 'connect', async (p) => {
      await p.connect(config);
    });

    if (res.isFailure) {
      try { await provider.disconnect(); } catch (_) {}
      this.pool.delete(cacheKey);
      throw new Error(res.error.message);
    }

    this.pool.set(cacheKey, provider);
    return provider;
  }

  /**
   * Creates a fresh, uncached Exchange Provider instance for validation flows.
   */
  public static async createUncachedProvider(exchangeId: string, config: ProviderConfig): Promise<IExchangeProvider> {
    const provider = ExchangeRegistry.create(exchangeId);
    const res = await this.orchestrator.execute(provider, 'connect', async (p) => {
      await p.connect(config);
    });
    if (res.isFailure) {
      throw new Error(res.error.message);
    }
    return provider;
  }

  /**
   * Disconnects and removes a provider from the pool (Fix EC-H5 & EC-L2).
   */
  public static async disconnectProvider(exchangeId: string, config: ProviderConfig): Promise<void> {
    const cacheKey = await this.getHashedCacheKey(exchangeId, config);
    const cached = this.pool.get(cacheKey);
    if (cached) {
      try {
        await cached.disconnect();
      } catch (_) {}
    }
    this.pool.delete(cacheKey);
  }

  /**
   * Executes a provider operation through the ExchangeOrchestrator pipeline
   * (Telemetry -> Capability -> RateLimit -> CircuitBreaker -> Retry -> Adapter -> ErrorTranslation).
   */
  public static async executeOrchestrated<T>(
    provider: IExchangeProvider,
    operationName: string,
    operation: (adapter: BaseExchangeAdapter) => Promise<T>
  ): Promise<Result<T>> {
    if (provider instanceof BaseExchangeAdapter) {
      return this.orchestrator.execute(provider, operationName, operation);
    }
    // Fix EC-M3: Throw UNSUPPORTED_OPERATION if not BaseExchangeAdapter
    throw new UnifiedError(
      `Provider for operations must be an instance of BaseExchangeAdapter. Received: ${typeof provider}`,
      'UNSUPPORTED_OPERATION'
    );
  }

  public static async executeIdempotentOrder(provider: IExchangeProvider, request: OrderRequest): Promise<Order> {
    const idempotentRequest = { ...request };
    if (!idempotentRequest.clientOrderId) {
      idempotentRequest.clientOrderId = crypto.randomUUID();
    }
    if (provider instanceof BaseExchangeAdapter) {
      const res = await this.orchestrator.execute(provider, 'createOrder', async (p) => {
        return p.createOrder(idempotentRequest);
      });
      if (res.isFailure) {
        const err = new Error(res.error.message);
        (err as any).technicalDetail = res.error.details?.technicalDetail;
        throw err;
      }
      return res.value;
    }
    return provider.createOrder(idempotentRequest);
  }

  public static async executeIdempotentOcoOrder(
    provider: IExchangeProvider,
    request: OcoOrderRequest
  ): Promise<OcoOrderResponse> {
    const idempotentRequest = { ...request };
    if (!idempotentRequest.listClientOrderId) {
      idempotentRequest.listClientOrderId = `oco_${crypto.randomUUID().replace(/-/g, '').substring(0, 32)}`;
    }
    if (provider instanceof BaseExchangeAdapter) {
      const res = await this.orchestrator.execute(provider, 'createOcoOrder', async (p) => {
        return p.createOcoOrder(idempotentRequest);
      });
      if (res.isFailure) {
        throw new Error(res.error.message);
      }
      return res.value;
    }
    return provider.createOcoOrder(idempotentRequest);
  }
}
