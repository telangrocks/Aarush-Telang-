// backend/src/utils/environment.ts

export type CanonicalEnvironment = "mainnet" | "testnet" | "demo";

/**
 * Normalizes an untrusted environment string into a canonical value ("mainnet", "testnet", "demo").
 * Returns null if the value is unrecognized, empty, null, or undefined.
 */
export function normalizeEnvironment(value: unknown): CanonicalEnvironment | null {
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "mainnet" || lower === "live" || lower === "production") {
      return "mainnet";
    }
    if (lower === "testnet" || lower === "testing" || lower === "sandbox") {
      return "testnet";
    }
    if (lower === "demo") {
      return "demo";
    }
  }
  return null;
}

/**
 * Resolves an environment string into a guaranteed CanonicalEnvironment, defaulting to "mainnet".
 */
export function resolveCanonicalEnvironment(value: unknown): CanonicalEnvironment {
  return normalizeEnvironment(value) ?? "mainnet";
}


/**
 * Supported environments per exchange registry.
 */
const SUPPORTED_ENVIRONMENTS: Record<string, CanonicalEnvironment[]> = {
  binance: ["mainnet", "testnet"],
  bybit: ["mainnet", "testnet", "demo"],
  kucoin: ["mainnet"],
};

/**
 * Returns true if the specified exchange supports the given canonical environment.
 */
export function isEnvironmentSupported(exchangeName: string, environment: CanonicalEnvironment): boolean {
  const exchangeKey = (exchangeName || "").toLowerCase().trim();
  const supported = SUPPORTED_ENVIRONMENTS[exchangeKey];
  if (!supported) {
    // Default fallback for any newly added adapter
    return environment === "mainnet" || environment === "testnet";
  }
  return supported.includes(environment);
}

/**
 * Returns a human-readable list of supported environments for an exchange.
 */
export function getSupportedEnvironmentsList(exchangeName: string): string {
  const exchangeKey = (exchangeName || "").toLowerCase().trim();
  const supported = SUPPORTED_ENVIRONMENTS[exchangeKey] || ["mainnet", "testnet"];
  return supported.join(", ");
}
