import { BaseExchangeAdapter } from '../adapters/BaseExchangeAdapter';
import { UnifiedError } from '../../../exchanges/models/UnifiedError';
import { StructuredLogger } from '../../telemetry/Telemetry';

export type AdapterFactory = () => BaseExchangeAdapter;

export interface ExchangePlugin {
  readonly exchangeId: string;
  readonly factory: AdapterFactory;
}

export class ExchangeRegistry {
  private static registry = new Map<string, AdapterFactory>();
  private static logger = new StructuredLogger();

  public static register(plugin: ExchangePlugin): void {
    const normalized = plugin.exchangeId.trim().toLowerCase();
    // Fix EC-L3: Warn on duplicate registration
    if (this.registry.has(normalized)) {
      this.logger.warn(`[ExchangeRegistry] Overwriting existing adapter factory registration for exchange '${normalized}'.`);
    }
    this.registry.set(normalized, plugin.factory);
  }

  public static create(exchangeId: string): BaseExchangeAdapter {
    const normalized = (exchangeId || '').trim().toLowerCase();
    const factory = this.registry.get(normalized);
    if (!factory) {
      throw new UnifiedError(`Exchange '${exchangeId}' is not registered in ExchangeRegistry.`, 'UNSUPPORTED_EXCHANGE');
    }
    return factory();
  }

  public static has(exchangeId: string): boolean {
    const normalized = (exchangeId || '').trim().toLowerCase();
    return this.registry.has(normalized);
  }

  public static getRegisteredExchanges(): string[] {
    return Array.from(this.registry.keys());
  }

  public static clear(): void {
    // Fix EC-L4: Warn on clear call
    this.logger.warn('[ExchangeRegistry] Clearing all registered exchange plugin factories.');
    this.registry.clear();
  }
}
