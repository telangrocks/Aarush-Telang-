import { IExchangeErrorMapper } from './IExchangeErrorMapper';
import { ExchangeErrorCode, ClassifiedError, FRIENDLY_MESSAGES } from '../errors';

export class BinanceErrorMapper implements IExchangeErrorMapper {
  readonly exchangeId = 'binance';

  public mapErrorPayload(
    _status: number,
    bodyText: string,
    _headers: Record<string, string>,
    technicalDetail: string
  ): ClassifiedError | null {
    if (!bodyText) return null;

    let code: number | undefined;
    let msg = '';

    try {
      const raw = bodyText.includes('{')
        ? bodyText.slice(bodyText.indexOf('{'), bodyText.lastIndexOf('}') + 1)
        : bodyText;
      const parsed = JSON.parse(raw) as { code?: number; msg?: string };
      if (typeof parsed.code === 'number') code = parsed.code;
      if (parsed.msg) msg = parsed.msg;
    } catch {
      const match = bodyText.match(/"code"\s*:\s*(-?\d+)/) || bodyText.match(/code=(-?\d+)/);
      if (match) code = parseInt(match[1], 10);
    }

    if (code === undefined) return null;

    // Binance code -2015: Invalid API-key, IP, or permissions for action
    if (code === -2015) {
      const lowerMsg = (msg || bodyText).toLowerCase();
      const ipMatch = bodyText.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      if (
        lowerMsg.includes('request ip:') ||
        lowerMsg.includes('ip whitelist') ||
        lowerMsg.includes('ip restricted') ||
        ipMatch
      ) {
        const hint = ipMatch
          ? `Crypto Pulse server IP is ${ipMatch[0]}. Please add this IP to your Binance API Key whitelist.`
          : FRIENDLY_MESSAGES.IP_NOT_WHITELISTED.hint;
        return {
          code: 'IP_NOT_WHITELISTED',
          friendlyMessage: FRIENDLY_MESSAGES.IP_NOT_WHITELISTED.friendlyMessage,
          hint,
          technicalDetail,
          version: '1.0',
        };
      }
      return this.mk('INVALID_API_KEY', technicalDetail);
    }

    const codeMap: Record<number, ExchangeErrorCode> = {
      [-2008]: 'INVALID_API_KEY', // Invalid Api-Key ID
      [-2014]: 'INVALID_API_KEY', // API-key format invalid
      [-2016]: 'INVALID_API_SECRET', // Invalid API secret / HMAC
      [-1022]: 'INVALID_SIGNATURE', // Signature for this request is not valid
      [-1021]: 'TIMESTAMP_OUT_OF_SYNC', // Timestamp for this request was outside of the recvWindow
      [-1003]: 'API_RATE_LIMIT_REACHED', // Too much request weight used
      [-1007]: 'NETWORK_TIMEOUT', // Timeout waiting for response
      [-1101]: 'UNKNOWN_EXCHANGE_ERROR', // Unknown endpoint
      [1101]: 'UNKNOWN_EXCHANGE_ERROR',
      [-1102]: 'INVALID_SIGNATURE', // Malformed/empty mandatory parameter
      [-1121]: 'INVALID_SIGNATURE', // Invalid symbol
      [-1010]: 'INSUFFICIENT_PERMISSIONS', // Customer's permissions don't match required API security
      [-2010]: 'INSUFFICIENT_PERMISSIONS', // Account has insufficient permission
      [-4164]: 'SPOT_TRADING_NOT_ENABLED', // Spot trading is not enabled
    };

    const targetCode = codeMap[code] || codeMap[-code];
    if (targetCode) {
      return this.mk(targetCode, technicalDetail);
    }

    return null;
  }

  private mk(code: ExchangeErrorCode, technicalDetail: string): ClassifiedError {
    const info = FRIENDLY_MESSAGES[code];
    return {
      code,
      friendlyMessage: info.friendlyMessage,
      hint: info.hint,
      technicalDetail,
      version: '1.0',
    };
  }
}
