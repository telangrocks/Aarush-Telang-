// backend/src/utils/environment.ts

export type CanonicalEnvironment = "mainnet" | "demo" | "testnet";

/**
 * Normalizes an untrusted environment string into a canonical value ("mainnet" | "demo" | "testnet").
 * Returns null if the value is unrecognized, empty, null, or undefined.
 */
export function normalizeEnvironment(value: unknown): CanonicalEnvironment | null {
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "mainnet" || lower === "real" || lower === "live" || lower === "production") {
      return "mainnet";
    }
    if (lower === "demo") {
      return "demo";
    }
    if (lower === "testnet") {
      return "testnet";
    }
  }
  return null;
}

/**
 * Resolves an environment string into a guaranteed CanonicalEnvironment, defaulting to "demo".
 */
export function resolveCanonicalEnvironment(value: unknown): CanonicalEnvironment {
  return normalizeEnvironment(value) ?? "demo";
}

/**
 * Supported environments per exchange registry.
 */
const SUPPORTED_ENVIRONMENTS: Record<string, CanonicalEnvironment[]> = {
  bybit: ["demo", "mainnet", "testnet"],
};

/**
 * Returns true if the specified exchange supports the given canonical environment.
 */
export function isEnvironmentSupported(exchangeName: string, environment: CanonicalEnvironment): boolean {
  const exchangeKey = (exchangeName || "").toLowerCase().trim();
  const supported = SUPPORTED_ENVIRONMENTS[exchangeKey];
  if (!supported) {
    return false;
  }
  return supported.includes(environment);
}

/**
 * Returns a human-readable list of supported environments for an exchange.
 */
export function getSupportedEnvironmentsList(exchangeName: string): string {
  const exchangeKey = (exchangeName || "").toLowerCase().trim();
  const supported = SUPPORTED_ENVIRONMENTS[exchangeKey] || ["demo", "mainnet"];
  return supported.join(", ");
}

