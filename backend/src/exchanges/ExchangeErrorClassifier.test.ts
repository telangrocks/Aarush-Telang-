import { describe, it, expect } from 'vitest';
import { ExchangeErrorClassifier } from './ExchangeErrorClassifier';
import { ExchangeSpecificationRegistry } from './registry/ExchangeSpecificationRegistry';

describe('ExchangeErrorClassifier & Enterprise Specification Registry Unit Tests', () => {
  const classifier = ExchangeErrorClassifier.getInstance();

  it('1. Should classify Binance -2015 invalid API key correctly', () => {
    const body = JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' });
    const res = classifier.classifyResponse('binance', 400, { 'content-type': 'application/json' }, body, 'corr-123');
    expect(res.code).toBe('INVALID_API_KEY');
    expect(res.friendlyMessage).toContain("API Key you entered isn't recognised");
    expect(res.version).toBe('1.0');
    expect(res.correlationId).toBe('corr-123');
  });

  it('2. Should classify Binance -2015 IP restricted error cleanly', () => {
    const body = JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action, request IP: 192.168.1.1' });
    const res = classifier.classifyResponse('binance', 400, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('IP_NOT_WHITELISTED');
    expect(res.hint).toContain('192.168.1.1');
  });

  it('3. Should classify Binance -1022 invalid signature error', () => {
    const body = JSON.stringify({ code: -1022, msg: 'Signature for this request is not valid.' });
    const res = classifier.classifyResponse('binance', 400, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('INVALID_SIGNATURE');
  });

  it('4. Should classify KuCoin 400001 invalid API key error', () => {
    const body = JSON.stringify({ code: '400001', msg: 'Invalid API key' });
    const res = classifier.classifyResponse('kucoin', 400, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('INVALID_API_KEY');
  });

  it('5. Should classify KuCoin 400003 IP not whitelisted error vs non-existent key', () => {
    const bodyKeyNotExists = JSON.stringify({ code: '400003', msg: 'The API key does not exist or site mismatch.' });
    const res1 = classifier.classifyResponse('kucoin', 400, { 'content-type': 'application/json' }, bodyKeyNotExists);
    expect(res1.code).toBe('INVALID_API_KEY');

    const bodyIpRestricted = JSON.stringify({ code: '400003', msg: 'IP restricted' });
    const res2 = classifier.classifyResponse('kucoin', 400, { 'content-type': 'application/json' }, bodyIpRestricted);
    expect(res2.code).toBe('IP_NOT_WHITELISTED');
  });

  it('6. Should classify KuCoin 400004 invalid passphrase error', () => {
    const body = JSON.stringify({ code: '400004', msg: 'Invalid Passphrase' });
    const res = classifier.classifyResponse('kucoin', 400, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('INVALID_PASSPHRASE');
  });

  it('7. Should classify Bybit 10003 invalid API key error', () => {
    const body = JSON.stringify({ retCode: 10003, retMsg: 'Invalid ApiKey' });
    const res = classifier.classifyResponse('bybit', 400, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('INVALID_API_KEY');
  });

  it('8. Should classify Bybit 10010 IP not whitelisted error', () => {
    const body = JSON.stringify({ retCode: 10010, retMsg: 'Unmatched IP address' });
    const res = classifier.classifyResponse('bybit', 400, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('IP_NOT_WHITELISTED');
  });

  it('9. Should classify HTTP 403 HTML Cloudflare WAF challenge page as BINANCE_WAF_BLOCKED', () => {
    const htmlBody = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Cloudflare Ray ID: 8abc123</body></html>';
    const headers = { 'content-type': 'text/html; charset=UTF-8', 'server': 'cloudflare', 'cf-ray': '8abc123' };
    const res = classifier.classifyResponse('binance', 403, headers, htmlBody);
    expect(res.code).toBe('BINANCE_WAF_BLOCKED');
  });

  it('10. Should classify HTTP 451 WITH explicit legal restriction payload as REGION_NOT_SUPPORTED', () => {
    const body = JSON.stringify({ message: 'Service unavailable in restricted jurisdiction due to legal compliance' });
    const res = classifier.classifyResponse('binance', 451, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('REGION_NOT_SUPPORTED');
  });

  it('11. Should classify HTTP 451 WITHOUT explicit legal restriction payload as LEGAL_RESTRICTION_UNKNOWN', () => {
    const body = JSON.stringify({ message: 'Generic status error' });
    const res = classifier.classifyResponse('binance', 451, { 'content-type': 'application/json' }, body);
    expect(res.code).toBe('LEGAL_RESTRICTION_UNKNOWN');
  });

  it('12. Should classify HTTP 401 as AUTHENTICATION_FAILED', () => {
    const res = classifier.classifyResponse('binance', 401, {}, 'Unauthorized');
    expect(res.code).toBe('AUTHENTICATION_FAILED');
  });

  it('13. Should classify HTTP 429 as API_RATE_LIMIT_REACHED', () => {
    const res = classifier.classifyResponse('binance', 429, {}, 'Too many requests');
    expect(res.code).toBe('API_RATE_LIMIT_REACHED');
  });

  it('14. Should classify HTTP 503 Service Unavailable as SERVICE_TEMPORARILY_UNAVAILABLE', () => {
    const res = classifier.classifyResponse('binance', 503, {}, 'Server busy');
    expect(res.code).toBe('SERVICE_TEMPORARILY_UNAVAILABLE');
  });

  it('15. Should classify AbortError / TimeoutError exception as NETWORK_TIMEOUT', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const res = classifier.classifyException(err, 'binance');
    expect(res.code).toBe('NETWORK_TIMEOUT');
  });

  it('16. Should handle malformed JSON body gracefully without throwing', () => {
    const res = classifier.classifyResponse('binance', 400, { 'content-type': 'application/json' }, 'NOT_JSON{{{');
    expect(res.code).toBe('AUTHENTICATION_FAILED');
  });

  it('17. Should look up ExchangeSpecification cleanly from ExchangeSpecificationRegistry', () => {
    const registry = ExchangeSpecificationRegistry.getInstance();
    const binanceSpec = registry.getSpecification('binance');
    expect(binanceSpec).toBeDefined();
    expect(binanceSpec?.displayName).toBe('Binance');
    expect(binanceSpec?.defaultCapabilities.supportsOco).toBe(true);
  });
});
