import { ExchangeErrorCode, ClassifiedError, FRIENDLY_MESSAGES } from './errors';
import { ExchangeSpecificationRegistry } from './registry/ExchangeSpecificationRegistry';

export class ExchangeErrorClassifier {
  private static instance: ExchangeErrorClassifier;
  private readonly ERROR_DTO_VERSION = '1.0';

  private constructor() {}

  public static getInstance(): ExchangeErrorClassifier {
    if (!ExchangeErrorClassifier.instance) {
      ExchangeErrorClassifier.instance = new ExchangeErrorClassifier();
    }
    return ExchangeErrorClassifier.instance;
  }

  /**
   * Primary entry point for classifying raw HTTP exchange responses.
   * Evaluation hierarchy:
   * 1. Transport/Network Failure
   * 2. Content-Type Analysis (HTML WAF vs JSON)
   * 3. Response Headers & Edge CDN Inspection
   * 4. Delegate to ExchangeSpecification error mapper (Binance, KuCoin, Bybit)
   * 5. HTTP Status Code Analysis (400, 401, 403, 429, 451, 5xx)
   * 6. Legal Restriction Evidence Verification for HTTP 451
   */
  public classifyResponse(
    exchangeId: string,
    status: number,
    headers: Record<string, string> | Headers,
    bodyText: string,
    correlationId?: string
  ): ClassifiedError {
    const normHeaders = this.normalizeHeaders(headers);
    const technicalDetail = `exchange=${exchangeId} status=${status} body=${(bodyText || '').slice(0, 500)}`;
    const contentType = (normHeaders['content-type'] || '').toLowerCase();
    const serverHeader = (normHeaders['server'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html') || (bodyText || '').trim().toLowerCase().startsWith('<!doctype html') || (bodyText || '').trim().toLowerCase().startsWith('<html');

    // 1. Content-Type & Edge Security Inspection (Cloudflare WAF / CDN Page)
    const lowerBody = (bodyText || '').toLowerCase();
    if (status === 403 && isHtml && (lowerBody.includes('cloudflare') || lowerBody.includes('waf') || lowerBody.includes('cf-challenge') || lowerBody.includes('attention required') || lowerBody.includes('just a moment'))) {
      return this.mk('WAF_BLOCKED', technicalDetail, correlationId);
    }

    // 2. Delegate to ExchangeSpecification error mapper
    const spec = ExchangeSpecificationRegistry.getInstance().getSpecification(exchangeId);
    if (spec) {
      const mapped = spec.mapper.mapErrorPayload(status, bodyText, normHeaders, technicalDetail);
      if (mapped) {
        return { ...mapped, version: this.ERROR_DTO_VERSION, correlationId: correlationId || mapped.correlationId };
      }
    }

    // 3. HTTP Status Code Classification Rules (Fix EC-H2)
    if (status === 400) {
      return this.mk('INVALID_REQUEST', technicalDetail, correlationId);
    }
    if (status === 401 || status === 403) {
      return this.mk('AUTHENTICATION_FAILED', technicalDetail, correlationId);
    }
    if (status === 404) {
      return this.mk('EXCHANGE_NOT_REACHABLE', technicalDetail, correlationId);
    }
    if (status === 408) {
      return this.mk('NETWORK_TIMEOUT', technicalDetail, correlationId);
    }
    if (status === 429) {
      return this.mk('API_RATE_LIMIT_REACHED', technicalDetail, correlationId);
    }

    // 4. HTTP 451 Legal Restriction Evidence Check
    if (status === 451) {
      const lowerBody = (bodyText || '').toLowerCase();
      const hasLegalEvidence =
        lowerBody.includes('jurisdiction') ||
        lowerBody.includes('restricted region') ||
        lowerBody.includes('restricted location') ||
        lowerBody.includes('sanction') ||
        lowerBody.includes('compliance') ||
        lowerBody.includes('legal');

      if (hasLegalEvidence) {
        return this.mk('REGION_NOT_SUPPORTED', technicalDetail, correlationId);
      }
      return this.mk('LEGAL_RESTRICTION_UNKNOWN', technicalDetail, correlationId);
    }

    if (status === 418 || status === 502 || status === 503 || status === 504 || status >= 500) {
      return this.mk('SERVICE_TEMPORARILY_UNAVAILABLE', technicalDetail, correlationId);
    }

    return this.mk('UNKNOWN_EXCHANGE_ERROR', technicalDetail, correlationId);
  }

  /**
   * Entry point for classifying thrown exceptions.
   */
  public classifyException(error: unknown, exchangeId: string, correlationId?: string): ClassifiedError {
    const errObj = error as any;
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    const technicalDetail = `exchange=${exchangeId} exception=${message.slice(0, 500)}`;

    const lower = message.toLowerCase();
    // Fix EC-M7: Map D1/SQLite errors to DATABASE_ERROR
    if (lower.includes('no such column') || lower.includes('d1_error') || lower.includes('sqlite')) {
      return this.mk('DATABASE_ERROR', technicalDetail, correlationId);
    }

    const targetCode = errObj?.mappedInternalErrorCode || errObj?.code;
    if (targetCode && FRIENDLY_MESSAGES[targetCode as ExchangeErrorCode]) {
      return this.mk(targetCode as ExchangeErrorCode, technicalDetail, correlationId);
    }

    const body = errObj?.responseBody || errObj?.originalExchangeErrorMessage || message;
    const spec = ExchangeSpecificationRegistry.getInstance().getSpecification(exchangeId);
    if (spec && body) {
      const mapped = spec.mapper.mapErrorPayload(errObj?.status || 400, body, {}, technicalDetail);
      if (mapped) {
        return { ...mapped, version: this.ERROR_DTO_VERSION, correlationId: correlationId || mapped.correlationId };
      }
    }

    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return this.mk('NETWORK_TIMEOUT', technicalDetail, correlationId);
    }
    if (error instanceof TypeError && lower.includes('fetch failed')) {
      return this.mk('EXCHANGE_NOT_REACHABLE', technicalDetail, correlationId);
    }

    // Fix EC-H4: Specific auth terms matching instead of broad "auth" substring
    if (
      lower.includes('401') ||
      lower.includes('403') ||
      lower.includes('unauthorized') ||
      lower.includes('invalid api key') ||
      lower.includes('invalid signature') ||
      lower.includes('authentication failed') ||
      lower.includes('credential')
    ) {
      return this.mk('AUTHENTICATION_FAILED', technicalDetail, correlationId);
    }

    return this.mk('UNKNOWN_EXCHANGE_ERROR', technicalDetail, correlationId);
  }

  private normalizeHeaders(headers: Record<string, string> | Headers): Record<string, string> {
    const result: Record<string, string> = {};
    if (!headers) return result;

    if (typeof (headers as Headers).forEach === 'function') {
      (headers as Headers).forEach((val, key) => {
        result[key.toLowerCase()] = val;
      });
    } else {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === 'string') {
          result[k.toLowerCase()] = v;
        }
      }
    }
    return result;
  }

  private mk(code: ExchangeErrorCode, technicalDetail: string, correlationId?: string): ClassifiedError {
    const info = FRIENDLY_MESSAGES[code];
    return {
      code,
      friendlyMessage: info.friendlyMessage,
      hint: info.hint,
      technicalDetail,
      version: this.ERROR_DTO_VERSION,
      correlationId,
    };
  }
}
