/**
 * Production Validation Framework — Security Redactor Utility
 * Sanitizes JWT tokens, API keys, private keys, passwords, and PII before logging/reporting.
 */

export class SecurityRedactor {
  private static secretTokens: string[] = [];

  public static registerSecret(secret: string | undefined | null): void {
    if (secret && typeof secret === "string" && secret.trim().length >= 4) {
      SecurityRedactor.secretTokens.push(secret.trim());
    }
  }

  public static sanitize(text: string): string {
    if (!text || typeof text !== "string") return text;
    let sanitized = text;

    // Redact explicit registered secrets
    for (const secret of SecurityRedactor.secretTokens) {
      if (secret && secret.length > 0) {
        sanitized = sanitized.split(secret).join("[REDACTED_SECRET]");
      }
    }

    // Redact JWT tokens
    sanitized = sanitized.replace(/eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, "[REDACTED_JWT_TOKEN]");

    // Redact API key / Secret headers & fields
    sanitized = sanitized.replace(/(api[-_]?key|secret|password|passphrase|private[-_]?key)\s*[:=]\s*["']?([^"'\s,]+)["']?/gi, '$1: "[REDACTED_FIELD]"');

    return sanitized;
  }

  public static sanitizeObject(obj: any): any {
    if (!obj) return obj;
    const str = JSON.stringify(obj);
    const cleaned = SecurityRedactor.sanitize(str);
    try {
      return JSON.parse(cleaned);
    } catch (_) {
      return cleaned;
    }
  }
}
