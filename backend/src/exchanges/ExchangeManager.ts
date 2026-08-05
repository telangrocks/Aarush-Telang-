import { IExchangeProvider } from './IExchangeProvider';
import { ProviderConfig } from './models/ConnectionConfig';
import { Order, OrderRequest, OcoOrderRequest, OcoOrderResponse } from './models/NormalizedDomain';
import { ExchangeRegistry } from '../infrastructure/exchange/registry/ExchangeRegistry';
import { BaseExchangeAdapter } from '../infrastructure/exchange/adapters/BaseExchangeAdapter';
import { BinanceAdapter } from '../infrastructure/exchange/adapters/BinanceAdapter';
import { KucoinAdapter } from '../infrastructure/exchange/adapters/KucoinAdapter';
import { BybitAdapter } from '../infrastructure/exchange/adapters/BybitAdapter';
import { ProviderPool } from '../infrastructure/cache/ProviderPool';
import { ExchangeOrchestrator } from '../infrastructure/orchestrator/ExchangeOrchestrator';
import { Result } from '../domain/types/Result';

// Bootstrap registration of polymorphic adapters
ExchangeRegistry.register({ exchangeId: 'binance', factory: () => new BinanceAdapter() });
ExchangeRegistry.register({ exchangeId: 'kucoin', factory: () => new KucoinAdapter() });
ExchangeRegistry.register({ exchangeId: 'bybit', factory: () => new BybitAdapter() });

export class ExchangeManager {
  private static pool = new ProviderPool(50, 15 * 60 * 1000);
  private static orchestrator = new ExchangeOrchestrator();

  /**
   * Retrieves a connected Exchange Provider from the bounded ProviderPool.
   */
  public static async getProvider(exchangeId: string, config: ProviderConfig): Promise<IExchangeProvider> {
    const cacheKey = await this.pool.generateCacheKey(
      exchangeId,
      config.environment,
      config.apiKey || '',
      config.secret || ''
    );

    const cached = this.pool.get(cacheKey);
    if (cached) {
      return cached;
    }

    const provider = ExchangeRegistry.create(exchangeId);
    try {
      await this.orchestrator.execute(provider, 'connect', async (p) => {
        await p.connect(config);
      });

      this.pool.set(cacheKey, provider);
      return provider;
    } catch (error) {
      try {
        await provider.disconnect();
      } catch (_) {
        // Disconnect error ignored during teardown
      }
      this.pool.delete(cacheKey);
      throw error;
    }
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
   * Disconnects and removes a provider from the pool.
   */
  public static async disconnectProvider(exchangeId: string, config: ProviderConfig): Promise<void> {
    const cacheKey = await this.pool.generateCacheKey(
      exchangeId,
      config.environment,
      config.apiKey || '',
      config.secret || ''
    );
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
    const res = await operation(provider as any);
    return { isSuccess: true, isFailure: false, value: res } as any;
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
        throw new Error(res.error.message);
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
      idempotentRequest.listClientOrderId = `oco_${crypto.randomUUID()}`;
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
