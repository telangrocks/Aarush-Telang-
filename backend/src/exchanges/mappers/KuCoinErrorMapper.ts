import { IExchangeErrorMapper } from './IExchangeErrorMapper';
import { ExchangeErrorCode, ClassifiedError, FRIENDLY_MESSAGES } from '../errors';

export class KuCoinErrorMapper implements IExchangeErrorMapper {
  readonly exchangeId = 'kucoin';

  public mapErrorPayload(
    _status: number,
    bodyText: string,
    _headers: Record<string, string>,
    technicalDetail: string
  ): ClassifiedError | null {
    if (!bodyText) return null;

    let code: string | undefined;
    let msg = '';
    try {
      const raw = bodyText.includes('{')
        ? bodyText.slice(bodyText.indexOf('{'), bodyText.lastIndexOf('}') + 1)
        : bodyText;
      const parsed = JSON.parse(raw) as { code?: string | number; msg?: string };
      if (typeof parsed.code === 'string') code = parsed.code;
      else if (typeof parsed.code === 'number') code = String(parsed.code);
      if (parsed.msg) msg = parsed.msg;
    } catch {
      const match = bodyText.match(/"code"\s*:\s*"(\d+)"/) || bodyText.match(/code="?(\d+)"?/);
      if (match) code = match[1];
    }

    if (!code) return null;

    if (code === '400003') {
      const lowerMsg = (msg || bodyText).toLowerCase();
      if (lowerMsg.includes('not exist') || lowerMsg.includes('site mismatch') || lowerMsg.includes('invalid') || lowerMsg.includes('api key')) {
        return this.mk('INVALID_API_KEY', technicalDetail);
      }
      return this.mk('IP_NOT_WHITELISTED', technicalDetail);
    }

    const codeMap: Record<string, ExchangeErrorCode> = {
      '400100': 'INVALID_SIGNATURE',
      '400001': 'INVALID_API_KEY',
      '400002': 'TIMESTAMP_OUT_OF_SYNC',
      '400004': 'INVALID_PASSPHRASE',
      '400005': 'TIMESTAMP_OUT_OF_SYNC',
      '400006': 'INVALID_API_VERSION',
      '400007': 'INVALID_SIGNATURE',
      '411100': 'ACCOUNT_RESTRICTED',
      '200004': 'INSUFFICIENT_BALANCE',
      '429000': 'API_RATE_LIMIT_REACHED',
      '500000': 'SERVICE_TEMPORARILY_UNAVAILABLE',
      '260100': 'INSUFFICIENT_BALANCE',
    };

    const targetCode = codeMap[code];
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
