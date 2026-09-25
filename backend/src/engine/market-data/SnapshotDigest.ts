import { NormalizedCandle, MarketSnapshot } from './MarketSnapshot';
import { WebCryptoSigner } from '../../infrastructure/crypto/WebCryptoSigner';

export const CANONICAL_SCANNER_TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;
export type CanonicalScannerTimeframe = typeof CANONICAL_SCANNER_TIMEFRAMES[number];

/**
 * Validates IEEE-754 float64 and formats canonical lossless decimal representation.
 * - Enforces finite number check: rejects NaN, +Infinity, -Infinity.
 * - Normalizes -0 to 0.
 * - Returns exact shortest unique decimal representation via toString(10) (ECMA-262).
 */
export function normalizeNumber(val: number): string {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`Invalid non-finite number encountered during canonical normalization: ${val}`);
  }
  if (Object.is(val, -0) || val === 0) {
    return '0';
  }
  return val.toString(10);
}

/**
 * Serializes a single normalized candle into canonical length-prefixed line.
 */
export function serializeCandle(candle: NormalizedCandle): string {
  const openTime = candle.openTime ?? candle.timestamp ?? 0;
  const otNorm = normalizeNumber(openTime);
  const oNorm = normalizeNumber(candle.open);
  const hNorm = normalizeNumber(candle.high);
  const lNorm = normalizeNumber(candle.low);
  const cNorm = normalizeNumber(candle.close);
  const vNorm = normalizeNumber(candle.volume);
  return `C:${otNorm}:${oNorm}:${hNorm}:${lNorm}:${cNorm}:${vNorm}`;
}

/**
 * Serializes a symbol's multi-timeframe candles into a canonical deterministic byte stream.
 */
export function serializeSymbolSnapshot(
  symbol: string,
  candlesRecord: Partial<Record<string, NormalizedCandle[]>>
): string {
  const cleanSymbol = symbol.trim().toUpperCase();
  const chunks: string[] = [`SYM:${cleanSymbol.length}:${cleanSymbol}`];

  for (const tf of CANONICAL_SCANNER_TIMEFRAMES) {
    const candles = candlesRecord[tf] || [];
    chunks.push(`TF:${tf}:${candles.length}`);
    // Sort candles chronologically by openTime
    const sorted = [...candles].sort((a, b) => {
      const aTime = a.openTime ?? a.timestamp ?? 0;
      const bTime = b.openTime ?? b.timestamp ?? 0;
      return aTime - bTime;
    });
    for (const c of sorted) {
      chunks.push(serializeCandle(c));
    }
  }

  return chunks.join('\n') + '\n';
}

/**
 * Serializes an entire scan's market snapshot collection deterministically.
 * Snapshots are sorted alphabetically by symbol to eliminate iteration order nondeterminism.
 */
export function serializeScanSnapshot(snapshots: MarketSnapshot[]): string {
  const sorted = [...snapshots].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return sorted
    .map((s) => serializeSymbolSnapshot(s.symbol, s.candles))
    .join('---SNAPSHOT-DELIMITER---\n');
}

/**
 * Computes pure market-data content hash (SHA-256).
 * Pure: invariant under scanId, timestamp, or DO instance identity.
 */
export async function computeScanContentHash(snapshots: MarketSnapshot[]): Promise<string> {
  const serialized = serializeScanSnapshot(snapshots);
  return await WebCryptoSigner.hashSha256(serialized);
}

/**
 * Computes scan instance digest binding execution identity to content hash.
 * Formatted as SHA-256(scanId:cutoffTs:version:scanContentHash).
 */
export async function computeScanInstanceDigest(
  scanId: string,
  cutoffTs: number,
  version: string,
  scanContentHash: string
): Promise<string> {
  const payload = `${scanId}:${cutoffTs}:${version}:${scanContentHash}`;
  return await WebCryptoSigner.hashSha256(payload);
}

/**
 * Deep freezes an object recursively to guarantee in-memory immutability
 * during zero-network multi-strategy evaluation.
 */
export function deepFreezeSnapshot<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  const propNames = Object.getOwnPropertyNames(obj);
  for (const name of propNames) {
    const value = (obj as any)[name];
    if (value && typeof value === 'object') {
      deepFreezeSnapshot(value);
    }
  }

  return Object.freeze(obj);
}
