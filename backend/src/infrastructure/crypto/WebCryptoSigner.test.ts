import { describe, it, expect } from 'vitest';
import { WebCryptoSigner } from './WebCryptoSigner';
import * as crypto from 'crypto';

describe('WebCryptoSigner Unit Tests', () => {
  it('HMAC-SHA256 Hex matches Node crypto reference', async () => {
    const secret = 'sD8iLnd2d6VudKpttnsBIzEJxXI7fJleEt5IabXcyTD3KsS3dKzNPAulCyVmgpS5';
    const payload = '17863518170006i7M8rbQiMUGU91n3J37KRUIaxYoqJ0oFUaWMH7JDVDjZ4KeBarzs70Wh5da1eoN5000accountType=UNIFIED';

    const nodeHex = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const webHex = await WebCryptoSigner.hmacSha256Hex(secret, payload);
    expect(webHex).toBe(nodeHex);
  });

  it('HMAC-SHA256 Base64 matches Node crypto reference', async () => {
    const secret = 'sD8iLnd2d6VudKpttnsBIzEJxXI7fJleEt5IabXcyTD3KsS3dKzNPAulCyVmgpS5';
    const payload = '17863518170006i7M8rbQiMUGU91n3J37KRUIaxYoqJ0oFUaWMH7JDVDjZ4KeBarzs70Wh5da1eoN5000accountType=UNIFIED';

    const nodeB64 = crypto.createHmac('sha256', secret).update(payload).digest('base64');
    const webB64 = await WebCryptoSigner.hmacSha256Base64(secret, payload);
    expect(webB64).toBe(nodeB64);
  });
});
