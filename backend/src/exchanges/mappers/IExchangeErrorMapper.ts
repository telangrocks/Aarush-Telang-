import { ExchangeErrorCode, ClassifiedError } from '../errors';

export interface IExchangeErrorMapper {
  readonly exchangeId: string;
  
  /**
   * Maps a raw exchange-specific error payload / code to a canonical ClassifiedError.
   * Returns null if the code or payload is not recognized by this specific mapper.
   */
  mapErrorPayload(
    status: number,
    bodyText: string,
    headers: Record<string, string>,
    technicalDetail: string
  ): ClassifiedError | null;
}
