import { IExchangeProvider } from './IExchangeProvider';
import { CcxtProvider } from './CcxtProvider';

export class ProviderFactory {
  public static create(exchangeId: string): IExchangeProvider {
    return new CcxtProvider(exchangeId);
  }
}
