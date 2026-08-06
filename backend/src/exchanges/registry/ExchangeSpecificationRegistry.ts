import { ExchangeSpecification } from './ExchangeSpecification';
import { BinanceErrorMapper } from '../mappers/BinanceErrorMapper';
import { KuCoinErrorMapper } from '../mappers/KuCoinErrorMapper';
import { BybitErrorMapper } from '../mappers/BybitErrorMapper';
import { DEFAULT_CAPABILITIES } from '../../domain/capabilities/ExchangeCapabilities';

export class ExchangeSpecificationRegistry {
  private static instance: ExchangeSpecificationRegistry;
  private specifications = new Map<string, ExchangeSpecification>();

  private constructor() {
    this.registerSpecification({
      exchangeId: 'binance',
      displayName: 'Binance',
      mapper: new BinanceErrorMapper(),
      defaultCapabilities: { ...DEFAULT_CAPABILITIES, supportsOco: true, supportsSandbox: true }
    });

    this.registerSpecification({
      exchangeId: 'kucoin',
      displayName: 'KuCoin',
      mapper: new KuCoinErrorMapper(),
      defaultCapabilities: { ...DEFAULT_CAPABILITIES, requiresPassphrase: true }
    });

    this.registerSpecification({
      exchangeId: 'bybit',
      displayName: 'Bybit',
      mapper: new BybitErrorMapper(),
      defaultCapabilities: { ...DEFAULT_CAPABILITIES, supportsSandbox: true, supportsFutures: true }
    });
  }

  public static getInstance(): ExchangeSpecificationRegistry {
    if (!ExchangeSpecificationRegistry.instance) {
      ExchangeSpecificationRegistry.instance = new ExchangeSpecificationRegistry();
    }
    return ExchangeSpecificationRegistry.instance;
  }

  public registerSpecification(spec: ExchangeSpecification): void {
    this.specifications.set(spec.exchangeId.toLowerCase(), spec);
  }

  public getSpecification(exchangeId: string): ExchangeSpecification | undefined {
    return this.specifications.get(exchangeId.toLowerCase());
  }

  public getAllSpecifications(): ExchangeSpecification[] {
    return Array.from(this.specifications.values());
  }
}
