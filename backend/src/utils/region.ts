// backend/src/utils/region.ts

export type CanonicalRegion = "india" | "global";

/**
 * Normalizes an untrusted region string into a valid CanonicalRegion ("india" or "global").
 * Case-insensitive parsing: "India", "INDIA", "india" -> "india".
 * Defaults to "india" if value is missing, empty, or unrecognized.
 */
export function normalizeRegion(value: unknown): CanonicalRegion {
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "india") {
      return "india";
    }
    if (lower === "global") {
      return "global";
    }
  }
  return "india";
}
