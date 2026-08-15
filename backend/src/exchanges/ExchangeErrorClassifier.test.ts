import { describe, it, expect } from 'vitest';
import { ExchangeErrorClassifier } from './ExchangeErrorClassifier';
import { ExchangeSpecificationRegistry } from './registry/ExchangeSpecificationRegistry';

describe('ExchangeErrorClassifier & Enterprise Specification Registry Unit Tests', () => {
  const classifier = ExchangeErrorClassifier.getInstance();

describe('ExchangeErrorClassifier & Enterprise Specification Registry Unit Tests', () => {
  const classifier = ExchangeErrorClassifier.getInstance();

  it('1. Should classify Bybit 10002 invalid API key error', () => {
    const body = JSON.stringify({ retCode: 10002, retMsg: 'invalid api_key' });
    const res = classifier.classifyResponse('bybit', 400, { 'content-type': 'application/json' }, body, 'corr-123');
    expect(res.code).toBe('INVALID_API_KEY');
    expect(res.version).toBe('1.0');
    expect(res.correlationId).toBe('corr-123');
  });

  it('2. Should classify Bybit 10003 timestamp error', () => {
    const body = JSON.stringify({ retCode: 10003, retMsg: 'req timestamp exceeds recv_window' });
    const res = classifier.classifyResponse('bybit', 400, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('TIMESTAMP_OUT_OF_SYNC');
  });

  it('3. Should classify Bybit 10004 invalid sign error', () => {
    const body = JSON.stringify({ retCode: 10004, retMsg: 'Error sign' });
    const res = classifier.classifyResponse('bybit', 400, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('INVALID_SIGNATURE');
  });

  it('4. Should classify Bybit 10010 IP not whitelisted error', () => {
    const body = JSON.stringify({ retCode: 10010, retMsg: 'Unmatched IP address' });
    const res = classifier.classifyResponse('bybit', 400, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('IP_NOT_WHITELISTED');
  });

  it('5. Should classify HTTP 403 HTML Cloudflare WAF challenge page as WAF_BLOCKED', () => {
    const htmlBody = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Cloudflare Ray ID: 8abc123</body></html>';
    const headers = { 'content-type': 'text/html; charset=UTF-8', 'server': 'cloudflare', 'cf-ray': '8abc123' };
    const res = classifier.classifyResponse('bybit', 403, headers, htmlBody);
    expect(res.code).toBe('WAF_BLOCKED');
  });

  it('5a. Should classify HTTP 403 + Bybit JSON retCode 10005 as INSUFFICIENT_PERMISSIONS and NOT WAF_BLOCKED', () => {
    const body = JSON.stringify({ retCode: 10005, retMsg: 'Permission denied' });
    const headers = { 'content-type': 'application/json', 'cf-ray': '8abc123-BOM' };
    const res = classifier.classifyResponse('bybit', 403, headers, body);
    expect(res.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(res.code).not.toBe('WAF_BLOCKED');
  });

  it('5b. Should NOT classify HTTP 403 + cf-ray header as WAF_BLOCKED when no WAF challenge HTML is present', () => {
    const body = JSON.stringify({ retCode: 10002, retMsg: 'invalid api_key' });
    const headers = { 'content-type': 'application/json', 'server': 'cloudflare', 'cf-ray': '8abc123-SIN' };
    const res = classifier.classifyResponse('bybit', 403, headers, body);
    expect(res.code).toBe('INVALID_API_KEY');
    expect(res.code).not.toBe('WAF_BLOCKED');
  });

  it('6. Should classify HTTP 401 as AUTHENTICATION_FAILED', () => {
    const res = classifier.classifyResponse('bybit', 401, { 'cf-ray': '8abc123-SIN' }, 'Unauthorized');
    expect(res.code).toBe('AUTHENTICATION_FAILED');
  });

  it('7. Should classify HTTP 429 as API_RATE_LIMIT_REACHED', () => {
    const res = classifier.classifyResponse('bybit', 429, {}, 'Too many requests');
    expect(res.code).toBe('API_RATE_LIMIT_REACHED');
  });

  it('8. Should classify HTTP 502/503 HTML server error as SERVICE_TEMPORARILY_UNAVAILABLE', () => {
    const htmlServerError = '<html><body>502 Bad Gateway</body></html>';
    const res502 = classifier.classifyResponse('bybit', 502, { 'content-type': 'text/html' }, htmlServerError);
    expect(res502.code).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');

    const res503 = classifier.classifyResponse('bybit', 503, { 'content-type': 'text/html' }, 'Server busy');
    expect(res503.code).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
  });

  it('9. Should look up ExchangeSpecification cleanly from ExchangeSpecificationRegistry', () => {
    const registry = ExchangeSpecificationRegistry.getInstance();
    const bybitSpec = registry.getSpecification('bybit');
    expect(bybitSpec).toBeDefined();
    expect(bybitSpec?.displayName).toBe('Bybit');
    expect(bybitSpec?.defaultCapabilities.supportsFutures).toBe(true);
  });
});
});
