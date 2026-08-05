import { IExchangeProvider } from './IExchangeProvider';
import { ExchangeRegistry } from '../infrastructure/exchange/registry/ExchangeRegistry';
import { BinanceAdapter } from '../infrastructure/exchange/adapters/BinanceAdapter';
import { KucoinAdapter } from '../infrastructure/exchange/adapters/KucoinAdapter';
import { BybitAdapter } from '../infrastructure/exchange/adapters/BybitAdapter';

// Ensure standard exchange adapters are registered
ExchangeRegistry.register({ exchangeId: 'binance', factory: () => new BinanceAdapter() });
ExchangeRegistry.register({ exchangeId: 'kucoin', factory: () => new KucoinAdapter() });
ExchangeRegistry.register({ exchangeId: 'bybit', factory: () => new BybitAdapter() });

export class ProviderFactory {
  public static create(exchangeId: string): IExchangeProvider {
    return ExchangeRegistry.create(exchangeId);
  }
}
