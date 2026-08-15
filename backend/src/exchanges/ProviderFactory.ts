import { IExchangeProvider } from './IExchangeProvider';
import { ExchangeRegistry } from '../infrastructure/exchange/registry/ExchangeRegistry';
import { BybitAdapter } from '../infrastructure/exchange/adapters/BybitAdapter';

// Ensure Bybit adapter is registered
ExchangeRegistry.register({ exchangeId: 'bybit', factory: () => new BybitAdapter() });

export class ProviderFactory {
  public static create(exchangeId: string): IExchangeProvider {
    return ExchangeRegistry.create(exchangeId);
  }
}
