// backend/src/utils/region.ts

export type StoredExchangeRegion = "india" | "global";
export type CanonicalRoutingRegion = "india";
export type CanonicalRegion = StoredExchangeRegion; // Backward compatibility alias

/**
 * Sanitizes untrusted region strings from request bodies or database rows.
 * Defaults to "india" if missing, null, undefined, or unrecognized.
 */
export function normalizeRegion(value: unknown): StoredExchangeRegion {
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "global") {
      return "global";
    }
    if (lower === "india") {
      return "india";
    }
  }
  return "india";
}

/**
 * Explicit Business Policy Layer:
 * Resolves any stored or requested region into the canonical India-only routing region ("india").
 * - Missing / null / undefined / unknown -> "india"
 * - Stored legacy D1 "global" -> "india"
 * - Explicit client request "global" -> "india"
 */
export function resolveCanonicalRoutingRegion(_region?: unknown): CanonicalRoutingRegion {
  return "india";
}

