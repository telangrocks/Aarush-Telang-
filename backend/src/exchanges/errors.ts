/**
 * Centralised, exchange-agnostic error classification for the connect-exchange
 * and bot-activation flows.
 *
 * Goal: never surface raw, technical exchange errors to end users. Every
 * failure is mapped to a stable `ExchangeErrorCode` that carries:
 *   - `code`          : stable machine-readable identifier
 *   - `friendlyMessage`: plain-language, actionable text shown in the app
 *   - `technicalDetail`: raw detail logged server-side only (never sent to app)
 *
 * The classification inspects HTTP status, response body text, and exception
 * types across Binance, Delta Exchange and Bybit.
 */

export type ExchangeErrorCode =
  | "INVALID_API_KEY"
  | "INVALID_API_SECRET"
  | "INVALID_PASSPHRASE"
  | "IP_NOT_WHITELISTED"
  | "FUTURES_TRADING_NOT_ENABLED"
  | "SPOT_TRADING_NOT_ENABLED"
  | "PERMISSION_DENIED"
  | "INVALID_SIGNATURE"
  | "TIMESTAMP_OUT_OF_SYNC"
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_RESTRICTED"
  | "API_RATE_LIMIT_REACHED"
  | "NETWORK_TIMEOUT"
  | "SSL_CONNECTION_FAILURE"
  | "EXCHANGE_UNDER_MAINTENANCE"
  | "SERVICE_TEMPORARILY_UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "REGION_NOT_SUPPORTED"
  | "EXCHANGE_NOT_REACHABLE"
  | "INSUFFICIENT_PERMISSIONS"
  | "INVALID_API_VERSION"
  | "MISSING_REQUIRED_CREDENTIALS"
  | "UNKNOWN_EXCHANGE_ERROR";

export interface ExchangeErrorInfo {
  code: ExchangeErrorCode;
  friendlyMessage: string;
  /** Short action hint shown under the message in the app. */
  hint?: string;
}

/**
 * Friendly, natural-language copy for every error code. Written for a
 * non-technical trader — no jargon, clear next step.
 */
export const FRIENDLY_MESSAGES: Record<ExchangeErrorCode, ExchangeErrorInfo> = {
  INVALID_API_KEY: {
    code: "INVALID_API_KEY",
    friendlyMessage: "The API Key you entered isn't recognised by the exchange.",
    hint: "Double-check the key for typos, or generate a fresh one in your exchange account settings.",
  },
  INVALID_API_SECRET: {
    code: "INVALID_API_SECRET",
    friendlyMessage: "The API Secret doesn't match the API Key.",
    hint: "Make sure you pasted the secret that belongs to this exact API Key (not an older one).",
  },
  INVALID_PASSPHRASE: {
    code: "INVALID_PASSPHRASE",
    friendlyMessage: "The API Passphrase you entered is incorrect.",
    hint: "Verify the passphrase created for this API key on the exchange.",
  },
  IP_NOT_WHITELISTED: {
    code: "IP_NOT_WHITELISTED",
    friendlyMessage: "Your exchange account restricts API access to specific IP addresses.",
    hint: "Add Crypto Pulse's server IP to your exchange API whitelist, or turn off IP restrictions for this key.",
  },
  FUTURES_TRADING_NOT_ENABLED: {
    code: "FUTURES_TRADING_NOT_ENABLED",
    friendlyMessage: "Futures trading is not enabled on this API key.",
    hint: "Go to your exchange API settings and check the 'Enable Futures' or 'Contract Trade' permission.",
  },
  SPOT_TRADING_NOT_ENABLED: {
    code: "SPOT_TRADING_NOT_ENABLED",
    friendlyMessage: "Spot trading is not enabled on this API key.",
    hint: "Go to your exchange API settings and check the 'Enable Spot Trading' permission.",
  },
  PERMISSION_DENIED: {
    code: "PERMISSION_DENIED",
    friendlyMessage: "Access denied. Your API key does not have the necessary permissions.",
    hint: "Ensure the key has 'Read' and 'Trade' (Spot/Contract) permissions enabled.",
  },
  INVALID_SIGNATURE: {
    code: "INVALID_SIGNATURE",
    friendlyMessage: "The request signature could not be verified by the exchange.",
    hint: "Verify your API Secret is correct and the system time matches the exchange server time.",
  },
  TIMESTAMP_OUT_OF_SYNC: {
    code: "TIMESTAMP_OUT_OF_SYNC",
    friendlyMessage: "Your device time appears to be out of sync.",
    hint: "Enable automatic date and time settings on your device, then try again.",
  },
  ACCOUNT_SUSPENDED: {
    code: "ACCOUNT_SUSPENDED",
    friendlyMessage: "Your exchange account is suspended.",
    hint: "Please contact the exchange customer support to resolve your account status.",
  },
  ACCOUNT_RESTRICTED: {
    code: "ACCOUNT_RESTRICTED",
    friendlyMessage: "Your exchange account has restrictions placed on it.",
    hint: "Ensure your account has completed KYC verification and has no active trading holds.",
  },
  API_RATE_LIMIT_REACHED: {
    code: "API_RATE_LIMIT_REACHED",
    friendlyMessage: "Too many requests were sent to the exchange too quickly.",
    hint: "Please wait a moment and try again.",
  },
  NETWORK_TIMEOUT: {
    code: "NETWORK_TIMEOUT",
    friendlyMessage: "We couldn't reach the exchange in time.",
    hint: "Check your internet connection or try again in a few moments.",
  },
  SSL_CONNECTION_FAILURE: {
    code: "SSL_CONNECTION_FAILURE",
    friendlyMessage: "Secure connection to the exchange failed.",
    hint: "The exchange secure certificate could not be verified or is blocked by your network.",
  },
  EXCHANGE_UNDER_MAINTENANCE: {
    code: "EXCHANGE_UNDER_MAINTENANCE",
    friendlyMessage: "The exchange is currently undergoing system maintenance.",
    hint: "The exchange has paused API operations. Please try again after maintenance completes.",
  },
  SERVICE_TEMPORARILY_UNAVAILABLE: {
    code: "SERVICE_TEMPORARILY_UNAVAILABLE",
    friendlyMessage: "The exchange service is temporarily unavailable.",
    hint: "The exchange servers are busy or experiencing downtime. Please try again in a few minutes.",
  },
  AUTHENTICATION_FAILED: {
    code: "AUTHENTICATION_FAILED",
    friendlyMessage: "We couldn't authenticate with the exchange using these credentials.",
    hint: "Verify your API Key and Secret, then try again.",
  },
  REGION_NOT_SUPPORTED: {
    code: "REGION_NOT_SUPPORTED",
    friendlyMessage: "This exchange or endpoint is not supported in your region.",
    hint: "Due to local regulations, some markets or products may be blocked. Verify your regional settings.",
  },
  EXCHANGE_NOT_REACHABLE: {
    code: "EXCHANGE_NOT_REACHABLE",
    friendlyMessage: "The exchange API is currently not reachable.",
    hint: "Check if the exchange is down, or if your local firewall/ISP is blocking access to it.",
  },
  INSUFFICIENT_PERMISSIONS: {
    code: "INSUFFICIENT_PERMISSIONS",
    friendlyMessage: "Your API key doesn't have the permissions Crypto Pulse needs.",
    hint: "Enable 'Read' and 'Trade' (spot) permissions, then reconnect. We never require withdrawal access.",
  },
  INVALID_API_VERSION: {
    code: "INVALID_API_VERSION",
    friendlyMessage: "The API version requested is no longer supported by the exchange.",
    hint: "Please update the application to use the latest supported API endpoints.",
  },
  MISSING_REQUIRED_CREDENTIALS: {
    code: "MISSING_REQUIRED_CREDENTIALS",
    friendlyMessage: "Required exchange credentials (API Key or Secret) are missing.",
    hint: "Please provide all required fields before connecting your exchange.",
  },
  UNKNOWN_EXCHANGE_ERROR: {
    code: "UNKNOWN_EXCHANGE_ERROR",
    friendlyMessage: "Something went wrong while connecting to the exchange.",
    hint: "Please try again. If the problem continues, contact support.",
  },
};

export interface ClassifiedError {
  code: ExchangeErrorCode;
  friendlyMessage: string;
  hint?: string;
  technicalDetail: string;
}

/**
 * Inspect a failed exchange validation response (HTTP status + body) and
 * classify the root cause into a stable, user-friendly error.
 */
export function classifyExchangeResponse(
  status: number,
  bodyText: string,
  exchangeName: string,
): ClassifiedError {
  const lower = (bodyText || "").toLowerCase();
  const technicalDetail = `exchange=${exchangeName} status=${status} body=${bodyText.slice(0, 500)}`;

  // ---- Network / availability (independent of credentials) ----
  if (status === 403 && (lower.includes("ip") || lower.includes("request blocked"))) {
    return mk("IP_NOT_WHITELISTED", technicalDetail, lower);
  }
  // For credential/permission errors Binance/Bybit return a structured
  // {code,...} / {retCode,...} body. Resolve it precisely before falling back
  // to generic auth failure.
  const structured =
    classifyBinanceCode(bodyText, technicalDetail) ??
    classifyBybitCode(bodyText, technicalDetail) ??
    classifyDeltaCode(bodyText, technicalDetail);
  if (structured) return structured;
  if (status === 401 || status === 403) {
    return mk("AUTHENTICATION_FAILED", technicalDetail, lower);
  }
  if (status === 404) {
    return mk("EXCHANGE_NOT_REACHABLE", technicalDetail, lower);
  }
  if (status === 408) {
    return mk("NETWORK_TIMEOUT", technicalDetail, lower);
  }
  if (status === 429) {
    return mk("API_RATE_LIMIT_REACHED", technicalDetail, lower);
  }
  if (lower.includes("maintenance") || lower.includes("upgrade")) {
    return mk("EXCHANGE_UNDER_MAINTENANCE", technicalDetail, lower);
  }
  if (status === 418 || status === 503 || status === 502 || status === 504) {
    return mk("SERVICE_TEMPORARILY_UNAVAILABLE", technicalDetail, lower);
  }
  if (status >= 500) {
    return mk("SERVICE_TEMPORARILY_UNAVAILABLE", technicalDetail, lower);
  }

  // ---- 4xx with a body: inspect the message text per exchange ----
  return classifyByBodyText(lower, technicalDetail, exchangeName);
}

/**
 * Map Binance's well-known structured error `code` values to accurate,
 * user-facing error codes. Binance returns these as `{"code": <int>, "msg": ...}`.
 * Using the numeric code is far more reliable than text heuristics and prevents
 * misclassification (e.g. a bad API key being reported as an IP-whitelist issue).
 *
 * Returns null when the code is not one we recognise or the body has no code,
 * so the caller can fall back to text-based classification.
 */
export function classifyBinanceCode(
  bodyText: string,
  technicalDetail: string,
): ClassifiedError | null {
  let code: number | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { code?: number };
    if (typeof parsed.code === "number") code = parsed.code;
  } catch {
    return null;
  }
  if (code === undefined) return null;

  // Reference: https://binance-docs.github.io/apidocs/spot/en/#error-codes
  const byCode: Record<number, ExchangeErrorCode> = {
    "-2014": "INVALID_API_KEY", // API-key format invalid
    "-2015": "INVALID_API_KEY", // Invalid API-key, IP, or permissions for ...
    "-2016": "INVALID_API_SECRET", // Invalid API secret / IP or permissions
    "-1022": "INVALID_SIGNATURE", // Invalid signature
    "-1021": "TIMESTAMP_OUT_OF_SYNC", // Timestamp for this request was outside of the recvWindow
    "-1003": "API_RATE_LIMIT_REACHED", // Too much request weight used
    "-1007": "NETWORK_TIMEOUT", // Timeout waiting for response
    "-1102": "INVALID_SIGNATURE", // Malformed/empty mandatory parameter
    "-1121": "INVALID_SIGNATURE", // Invalid symbol
    "-1010": "INSUFFICIENT_PERMISSIONS", // Customer's permissions don't match
    "-2010": "INSUFFICIENT_PERMISSIONS", // Account has insufficient permission
    "-2027": "FUTURES_TRADING_NOT_ENABLED", // Futures trading is not enabled
    "-4164": "SPOT_TRADING_NOT_ENABLED", // Spot trading is not enabled
  };

  const mapped = byCode[code];
  if (mapped) return mk(mapped, technicalDetail, `binance code ${code}`);
  return null;
}

/**
 * Map Bybit's well-known structured `retCode` values to accurate, user-facing
 * error codes. Bybit (v5) returns errors as `{"retCode": <int>, "retMsg": ...}`,
 * which is distinct from Binance's `code`/`msg` shape. Mapping the numeric code
 * gives precise, actionable messages instead of the generic fallback.
 *
 * Returns null when the retCode is unrecognised or absent so the caller can
 * fall back to text-based classification.
 */
export function classifyBybitCode(
  bodyText: string,
  technicalDetail: string,
): ClassifiedError | null {
  let retCode: number | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { retCode?: number };
    if (typeof parsed.retCode === "number") retCode = parsed.retCode;
  } catch {
    return null;
  }
  if (retCode === undefined) return null;

  // Reference: https://bybit-exchange.github.io/docs/v5/errors
  const byCode: Record<number, ExchangeErrorCode> = {
    10001: "UNKNOWN_EXCHANGE_ERROR", // parameter error (generic) - keep generic
    10003: "INVALID_API_KEY", // API key is invalid
    10004: "INVALID_API_KEY", // invalid api key (variants)
    10005: "INSUFFICIENT_PERMISSIONS", // permission denied / api key not authorized
    10006: "INSUFFICIENT_PERMISSIONS", // insufficient permission
    10009: "TIMESTAMP_OUT_OF_SYNC", // api timestamp expired
    10010: "INVALID_SIGNATURE", // invalid sign / signature
    10012: "INVALID_SIGNATURE", // invalid parameter (incl. sign-related)
    10013: "IP_NOT_WHITELISTED", // ip not allowed
    10018: "API_RATE_LIMIT_REACHED", // too many visits / request frequency
    10029: "API_RATE_LIMIT_REACHED", // frequency limit reached
    160003: "FUTURES_TRADING_NOT_ENABLED", // contract trading not enabled variants
    130021: "FUTURES_TRADING_NOT_ENABLED",
    110007: "SPOT_TRADING_NOT_ENABLED", // spot trading not enabled variants
    110009: "SPOT_TRADING_NOT_ENABLED",
  };

  const mapped = byCode[retCode];
  if (mapped) return mk(mapped, technicalDetail, `bybit retCode ${retCode}`);
  return null;
}

/**
 * Map Delta Exchange's structured error `code` inside the `error` object.
 * Delta returns errors as `{"success": false, "error": {"code": "...", "message": "..."}}`.
 */
export function classifyDeltaCode(
  bodyText: string,
  technicalDetail: string,
): ClassifiedError | null {
  let errCode: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: string } };
    if (parsed?.error?.code) {
      errCode = parsed.error.code.toLowerCase();
    }
  } catch {
    return null;
  }
  if (!errCode) return null;

  const byCode: Record<string, ExchangeErrorCode> = {
    "invalid_api_key": "INVALID_API_KEY",
    "api_key_invalid": "INVALID_API_KEY",
    "signature_invalid": "INVALID_SIGNATURE",
    "signatureexpired": "INVALID_SIGNATURE",
    "timestamp_invalid": "TIMESTAMP_OUT_OF_SYNC",
    "timestamp_expired": "TIMESTAMP_OUT_OF_SYNC",
    "unauthorized": "INSUFFICIENT_PERMISSIONS",
    "insufficient_permissions": "INSUFFICIENT_PERMISSIONS",
    "rate_limit_exceeded": "API_RATE_LIMIT_REACHED",
    "maintenance": "EXCHANGE_UNDER_MAINTENANCE",
    "ip_restricted": "IP_NOT_WHITELISTED",
  };

  const mapped = byCode[errCode];
  if (mapped) return mk(mapped, technicalDetail, `delta code ${errCode}`);
  return null;
}

/**
 * Classify based on the human-readable error text returned by the exchange.
 * Covers Binance, Delta Exchange and Bybit message conventions.
 */
export function classifyByBodyText(
  lower: string,
  technicalDetail: string,
  _exchangeName: string,
): ClassifiedError {
  // Prefer the exchange's structured numeric error code when present — it is
  // the most accurate signal and avoids ambiguous text matching. Binance uses
  // {code}, Bybit uses {retCode}.
  const bodyRaw = technicalDetail.split("body=")[1] ?? "";
  const structured =
    classifyBinanceCode(bodyRaw, technicalDetail) ??
    classifyBybitCode(bodyRaw, technicalDetail) ??
    classifyDeltaCode(bodyRaw, technicalDetail);
  if (structured) return structured;
  // IP allow-list / restriction
  if (
    lower.includes("ip") && (lower.includes("not allow") || lower.includes("whitelist") || lower.includes("allowlist") || lower.includes("forbidden") || lower.includes("banned") || lower.includes("not permitted"))
  ) {
    return mk("IP_NOT_WHITELISTED", technicalDetail, lower);
  }
  // Futures/Spot specific permissions
  if (lower.includes("futures") && (lower.includes("not enabled") || lower.includes("disabled") || lower.includes("futures trading"))) {
    return mk("FUTURES_TRADING_NOT_ENABLED", technicalDetail, lower);
  }
  if (lower.includes("spot") && (lower.includes("not enabled") || lower.includes("disabled") || lower.includes("spot trading"))) {
    return mk("SPOT_TRADING_NOT_ENABLED", technicalDetail, lower);
  }
  // Passphrase
  if (lower.includes("passphrase") || lower.includes("password") || lower.includes("invalid passphrase")) {
    return mk("INVALID_PASSPHRASE", technicalDetail, lower);
  }
  // Explicit API-key invalid (Bybit: "API key is invalid", Delta: similar)
  if (lower.includes("api key") && (lower.includes("invalid") || lower.includes("not valid") || lower.includes("not found") || lower.includes("incorrect"))) {
    return mk("INVALID_API_KEY", technicalDetail, lower);
  }
  // Permission / scope errors (read/trade/withdraw)
  if (
    lower.includes("permission") ||
    lower.includes("api-key") && lower.includes("permission") ||
    lower.includes("not have") && lower.includes("permission") ||
    lower.includes("unauthorized") && lower.includes("permission") ||
    lower.includes("insufficient") && lower.includes("permission") ||
    lower.includes("forbidden") ||
    lower.includes("api key does not have") ||
    lower.includes("key does not have") ||
    lower.includes("permission denied") ||
    lower.includes("require") && lower.includes("permission")
  ) {
    return mk("INSUFFICIENT_PERMISSIONS", technicalDetail, lower);
  }
  // API Version
  if (lower.includes("api version") || lower.includes("deprecated version") || lower.includes("version not supported")) {
    return mk("INVALID_API_VERSION", technicalDetail, lower);
  }
  // Region
  if (lower.includes("region") || lower.includes("country") || lower.includes("not supported in this region") || lower.includes("geo-block")) {
    return mk("REGION_NOT_SUPPORTED", technicalDetail, lower);
  }
  // Account status
  if (lower.includes("suspended") || lower.includes("suspend")) {
    return mk("ACCOUNT_SUSPENDED", technicalDetail, lower);
  }
  if (lower.includes("restricted") || lower.includes("restrict") || lower.includes("frozen")) {
    return mk("ACCOUNT_RESTRICTED", technicalDetail, lower);
  }
  // Testnet vs live mismatch
  if (
    lower.includes("testnet") && lower.includes("mainnet") ||
    lower.includes("mainnet") && lower.includes("testnet") ||
    lower.includes("invalid api") && (lower.includes("environment") || lower.includes("network")) ||
    lower.includes("api key is for testnet") ||
    lower.includes("api key is for mainnet") ||
    lower.includes("wrong") && lower.includes("environment") ||
    lower.includes("sandbox") && lower.includes("production")
  ) {
    return mk("AUTHENTICATION_FAILED", technicalDetail, lower); // Mapped under auth mismatch
  }
  // Explicit signature failures
  if (lower.includes("signature") || lower.includes("sign") && lower.includes("invalid") || lower.includes("invalid signature")) {
    return mk("INVALID_SIGNATURE", technicalDetail, lower);
  }
  // Timestamp out of sync
  if (lower.includes("timestamp") || lower.includes("recvwindow") || (lower.includes("time") && lower.includes("outside"))) {
    return mk("TIMESTAMP_OUT_OF_SYNC", technicalDetail, lower);
  }
  // Rate limiting by message
  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("request frequency") ||
    lower.includes("too many") && lower.includes("request")
  ) {
    return mk("API_RATE_LIMIT_REACHED", technicalDetail, lower);
  }
  // Timeout by message
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return mk("NETWORK_TIMEOUT", technicalDetail, lower);
  }
  // Distinguish key vs secret when explicitly stated
  if (lower.includes("api key") && lower.includes("not found")) {
    return mk("INVALID_API_KEY", technicalDetail, lower);
  }
  if (lower.includes("api secret") && (lower.includes("invalid") || lower.includes("not valid"))) {
    return mk("INVALID_API_SECRET", technicalDetail, lower);
  }

  return mk("UNKNOWN_EXCHANGE_ERROR", technicalDetail, lower);
}

function mk(
  code: ExchangeErrorCode,
  technicalDetail: string,
  _lowerBody: string,
): ClassifiedError {
  const info = FRIENDLY_MESSAGES[code];
  return {
    code,
    friendlyMessage: info.friendlyMessage,
    hint: info.hint,
    technicalDetail,
  };
}

/**
 * Classify a thrown exception (network failure, timeout, JSON parse, etc.).
 */
export function classifyException(error: unknown, exchangeName: string): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  const lower = message.toLowerCase();
  const technicalDetail = `exchange=${exchangeName} exception=${message.slice(0, 500)}`;

  // Fetch timeout (Cloudflare Workers AbortError / TimeoutError)
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError" || lower.includes("timeout") || lower.includes("timed out"))
  ) {
    return mk("NETWORK_TIMEOUT", technicalDetail, lower);
  }
  // SSL connection failures
  if (lower.includes("ssl") || lower.includes("tls") || lower.includes("cert")) {
    return mk("SSL_CONNECTION_FAILURE", technicalDetail, lower);
  }
  // Network-level failures
  if (
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("dns") ||
    lower.includes("enotfound") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("connection") ||
    lower.includes("socket")
  ) {
    return mk("EXCHANGE_NOT_REACHABLE", technicalDetail, lower);
  }
  // Cloudflare HTML error bodies sometimes surface as thrown errors
  if (lower.includes("403") || lower.includes("request blocked") || lower.includes("forbidden")) {
    return mk("IP_NOT_WHITELISTED", technicalDetail, lower);
  }

  return mk("UNKNOWN_EXCHANGE_ERROR", technicalDetail, lower);
}

/**
 * Convenience wrapper used by adapters when they already hold a parsed error
 * message string (e.g. `data.error.message`). Lowercases before classification.
 */
export function classifyByBody(bodyText: string, exchangeName: string): ClassifiedError {
  return classifyByBodyText((bodyText || "").toLowerCase(), `exchange=${exchangeName} body=${bodyText.slice(0, 500)}`, exchangeName);
}
