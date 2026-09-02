import { IExchangeErrorMapper } from './IExchangeErrorMapper';
import { ExchangeErrorCode, ClassifiedError, FRIENDLY_MESSAGES } from '../errors';

export class BybitErrorMapper implements IExchangeErrorMapper {
  readonly exchangeId = 'bybit';

  public mapErrorPayload(
    _status: number,
    bodyText: string,
    _headers: Record<string, string>,
    technicalDetail: string
  ): ClassifiedError | null {
    if (!bodyText) return null;

    let retCode: number | undefined;
    let retMsg: string | undefined;
    try {
      const raw = bodyText.includes('{')
        ? bodyText.slice(bodyText.indexOf('{'), bodyText.lastIndexOf('}') + 1)
        : bodyText;
      const parsed = JSON.parse(raw) as { retCode?: number; ret_code?: number; retMsg?: string; ret_msg?: string };
      if (typeof parsed.retCode === 'number') retCode = parsed.retCode;
      else if (typeof parsed.ret_code === 'number') retCode = parsed.ret_code;
      retMsg = parsed.retMsg || parsed.ret_msg;
    } catch {
      const match = bodyText.match(/"retCode"\s*:\s*(-?\d+)/) || bodyText.match(/"ret_code"\s*:\s*(-?\d+)/);
      if (match) retCode = parseInt(match[1], 10);
    }

    if (retCode === undefined) return null;

    const codeMap: Record<number, ExchangeErrorCode> = {
      10001: 'INVALID_REQUEST', // Parameter error
      10002: 'INVALID_API_KEY', // Invalid API key
      10003: 'TIMESTAMP_OUT_OF_SYNC', // Timestamp exceeds recvWindow
      10004: 'INVALID_SIGNATURE', // Invalid sign
      10005: 'INSUFFICIENT_PERMISSIONS', // Permission denied
      10006: 'API_RATE_LIMIT_REACHED', // Too many requests
      10010: 'IP_NOT_WHITELISTED', // Unmatched IP address
      10014: 'INVALID_SIGNATURE', // Invalid parameter
      10018: 'IP_NOT_WHITELISTED', // IP restricted
      33004: 'INVALID_API_KEY', // API key not found / not recognized on endpoint
      130006: 'INSUFFICIENT_BALANCE', // Insufficient balance
      130021: 'SPOT_TRADING_NOT_ENABLED',
    };

    if (retCode === 33004) {
      return {
        code: 'INVALID_API_KEY',
        friendlyMessage: 'The API Key you entered was not recognized by Bybit.',
        hint: 'Verify your API Key for typos. If the key is valid, make sure the Environment toggle (Demo vs Real) matches where the key was created on Bybit.',
        technicalDetail,
        version: '1.0',
      };
    }

    const targetCode = codeMap[retCode];
    if (targetCode) {
      return this.mk(targetCode, technicalDetail);
    }

    if (retMsg) {
      return {
        code: 'INVALID_REQUEST',
        friendlyMessage: `Bybit Error [${retCode}]: ${retMsg}`,
        hint: `Bybit API returned code ${retCode}: ${retMsg}`,
        technicalDetail,
        version: '1.0'
      };
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
