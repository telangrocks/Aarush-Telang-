export class SecureMemory {
  /**
   * Performs a constant-time comparison between two strings to prevent timing side-channel attacks.
   */
  public static timingSafeEqual(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;

    const lengthA = a.length;
    const lengthB = b.length;
    let mismatch = lengthA ^ lengthB;

    const maxLen = Math.max(lengthA, lengthB);
    for (let i = 0; i < maxLen; i++) {
      const charA = i < lengthA ? a.charCodeAt(i) : 0;
      const charB = i < lengthB ? b.charCodeAt(i) : 0;
      mismatch |= charA ^ charB;
    }

    return mismatch === 0;
  }

  /**
   * Generates cryptographically secure random bytes using Web Crypto standard.
   */
  public static generateSecureNonce(length: number = 16): Uint8Array {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  /**
   * Best-effort memory zeroization for mutable TypedArray buffers.
   */
  public static zeroizeBuffer(buffer: Uint8Array | Uint8ClampedArray): void {
    if (buffer && buffer.fill) {
      buffer.fill(0);
    }
  }
}
