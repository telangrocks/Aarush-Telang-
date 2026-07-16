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
  | "MISSING_PERMISSIONS"
  | "NETWORK_MISMATCH"
  | "IP_WHITELIST_BLOCKED"
  | "EXCHANGE_UNAVAILABLE"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "AUTHENTICATION_FAILED"
  | "INVALID_EXCHANGE"
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
  MISSING_PERMISSIONS: {
    code: "MISSING_PERMISSIONS",
    friendlyMessage: "Your API key doesn't have the permissions Crypto Pulse needs.",
    hint: "Enable 'Read' and 'Trade' (spot) permissions, then reconnect. We never require withdrawal access.",
  },
  NETWORK_MISMATCH: {
    code: "NETWORK_MISMATCH",
    friendlyMessage: "This API key belongs to a different environment than the one you selected.",
    hint: "If you're using Testnet keys, choose Testnet. For live keys, choose Live (Real).",
  },
  IP_WHITELIST_BLOCKED: {
    code: "IP_WHITELIST_BLOCKED",
    friendlyMessage: "Your exchange account restricts API access to specific IP addresses.",
    hint: "Add Crypto Pulse's server IP to your exchange API whitelist, or turn off IP restrictions for this key.",
  },
  EXCHANGE_UNAVAILABLE: {
    code: "EXCHANGE_UNAVAILABLE",
    friendlyMessage: "The exchange API is temporarily unavailable.",
    hint: "This is on the exchange's side. Please try again in a few minutes.",
  },
  TIMEOUT: {
    code: "TIMEOUT",
    friendlyMessage: "We couldn't reach the exchange in time.",
    hint: "Check your internet connection and try again. If it continues, the exchange may be slow right now.",
  },
  RATE_LIMITED: {
    code: "RATE_LIMITED",
    friendlyMessage: "Too many requests were sent to the exchange too quickly.",
    hint: "Please wait a moment and try again.",
  },
  AUTHENTICATION_FAILED: {
    code: "AUTHENTICATION_FAILED",
    friendlyMessage: "We couldn't authenticate with the exchange using these credentials.",
    hint: "Verify your API Key and Secret, then try again.",
  },
  INVALID_EXCHANGE: {
    code: "INVALID_EXCHANGE",
    friendlyMessage: "That exchange isn't supported yet.",
    hint: "Choose Binance, Delta Exchange or Bybit from the list.",
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
  if (status === 403 && lower.includes("request blocked")) {
    return mk("IP_WHITELIST_BLOCKED", technicalDetail, lower);
  }
  if (status === 401 || status === 403) {
    // Could be key/secret or permissions — refine below, default to auth.
    return mk("AUTHENTICATION_FAILED", technicalDetail, lower);
  }
  if (status === 404) {
    return mk("EXCHANGE_UNAVAILABLE", technicalDetail, lower);
  }
  if (status === 408) {
    return mk("TIMEOUT", technicalDetail, lower);
  }
  if (status === 429) {
    return mk("RATE_LIMITED", technicalDetail, lower);
  }
  if (status === 418 || status === 503 || status === 502 || status === 504) {
    return mk("EXCHANGE_UNAVAILABLE", technicalDetail, lower);
  }
  if (status >= 500) {
    return mk("EXCHANGE_UNAVAILABLE", technicalDetail, lower);
  }

  // ---- 4xx with a body: inspect the message text per exchange ----
  return classifyByBodyText(lower, technicalDetail, exchangeName);
}

/**
 * Classify based on the human-readable error text returned by the exchange.
 * Covers Binance, Delta Exchange and Bybit message conventions.
 */
export function classifyByBodyText(
  lower: string,
  technicalDetail: string,
  exchangeName: string,
): ClassifiedError {
  // IP allow-list / restriction
  if (
    lower.includes("ip") && (lower.includes("not allow") || lower.includes("whitelist") || lower.includes("allowlist") || lower.includes("forbidden") || lower.includes("banned") || lower.includes("not permitted"))
  ) {
    return mk("IP_WHITELIST_BLOCKED", technicalDetail, lower);
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
    return mk("MISSING_PERMISSIONS", technicalDetail, lower);
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
    return mk("NETWORK_MISMATCH", technicalDetail, lower);
  }
  // Explicit auth / signature failures
  if (
    lower.includes("signature") ||
    lower.includes("sign") && lower.includes("invalid") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid api-key") ||
    lower.includes("invalid key") ||
    lower.includes("api-key format") ||
    lower.includes("apikey") && lower.includes("invalid") ||
    lower.includes("invalid signature") ||
    lower.includes("bad api") ||
    lower.includes("unauthorized") ||
    lower.includes("api key") && lower.includes("invalid")
  ) {
    return mk("AUTHENTICATION_FAILED", technicalDetail, lower);
  }
  // Rate limiting by message
  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("request frequency") ||
    lower.includes("too many") && lower.includes("request")
  ) {
    return mk("RATE_LIMITED", technicalDetail, lower);
  }
  // Timeout by message
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return mk("TIMEOUT", technicalDetail, lower);
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
    return mk("TIMEOUT", technicalDetail, lower);
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
    return mk("TIMEOUT", technicalDetail, lower);
  }
  // Cloudflare HTML error bodies sometimes surface as thrown errors
  if (lower.includes("403") || lower.includes("request blocked") || lower.includes("forbidden")) {
    return mk("IP_WHITELIST_BLOCKED", technicalDetail, lower);
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
