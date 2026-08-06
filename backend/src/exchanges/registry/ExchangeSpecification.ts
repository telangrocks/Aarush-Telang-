import { IExchangeErrorMapper } from '../mappers/IExchangeErrorMapper';
import { ExchangeCapabilities } from '../../domain/capabilities/ExchangeCapabilities';

export interface ExchangeSpecification {
  readonly exchangeId: string;
  readonly displayName: string;
  readonly mapper: IExchangeErrorMapper;
  readonly defaultCapabilities: ExchangeCapabilities;
}
