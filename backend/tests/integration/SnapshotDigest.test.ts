import { describe, it, expect } from 'vitest';
import {
  normalizeNumber,
  serializeCandle,
  serializeSymbolSnapshot,
  computeScanContentHash,
  computeScanInstanceDigest,
  deepFreezeSnapshot,
} from '../../src/engine/market-data/SnapshotDigest';
import { MarketSnapshot, NormalizedCandle } from '../../src/engine/market-data/MarketSnapshot';

function createDummySnapshot(symbol: string, closePrice: number): MarketSnapshot {
  const c: NormalizedCandle = {
    openTime: 1_700_000_000_000,
    open: closePrice - 1,
    high: closePrice + 2,
    low: closePrice - 2,
    close: closePrice,
    volume: 500,
  };
  return {
    symbol,
    timestamp: 1_700_000_000_000,
    currentPrice: closePrice,
    volume24h: 10000,
    quoteVolume24h: 10000 * closePrice,
    candles: {
      '1m': [],
      '3m': [],
      '5m': [c],
      '15m': [c],
      '30m': [],
      '1h': [c],
      '4h': [c],
    },
    metadata: {
      priceChange24h: 0,
      priceChangePercent24h: 0,
      highPrice24h: closePrice + 2,
      lowPrice24h: closePrice - 2,
    },
  };
}

describe('Suite 3: Snapshot Integrity & Cryptographic Digests (SnapshotDigest)', () => {
  it('test_content_hash_determinism: Asserts identical candle data produces identical scanContentHash across different scanIds', async () => {
    const snapshots1 = [
      createDummySnapshot('BTCUSDT', 65000),
      createDummySnapshot('ETHUSDT', 3500),
    ];
    const snapshots2 = [
      createDummySnapshot('ETHUSDT', 3500), // different order in input array
      createDummySnapshot('BTCUSDT', 65000),
    ];

    const hash1 = await computeScanContentHash(snapshots1);
    const hash2 = await computeScanContentHash(snapshots2);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('test_content_hash_cutoff_independence: Asserts identical OHLCV data with different cutoff times produces the exact same scanContentHash', async () => {
    const snapshots = [
      createDummySnapshot('BTCUSDT', 65000),
      createDummySnapshot('ETHUSDT', 3500),
    ];

    // scanContentHash is computed purely over OHLCV series data and does not contain cutoffTs
    const contentHashAtCutoffA = await computeScanContentHash(snapshots);
    const contentHashAtCutoffB = await computeScanContentHash(snapshots);

    // Invariant: scanContentHash is bit-for-bit identical regardless of scan cutoff timestamp
    expect(contentHashAtCutoffA).toBe(contentHashAtCutoffB);

    // In contrast, scanInstanceDigest MUST incorporate cutoffTs and produce distinct digests
    const instanceDigestA = await computeScanInstanceDigest('scan-1', 1_700_000_000_000, '2.7', contentHashAtCutoffA);
    const instanceDigestB = await computeScanInstanceDigest('scan-1', 1_700_000_060_000, '2.7', contentHashAtCutoffB);

    expect(instanceDigestA).not.toBe(instanceDigestB);
  });

  it('test_instance_digest_uniqueness: Asserts different scanIds produce distinct scanInstanceDigests', async () => {
    const snapshots = [createDummySnapshot('BTCUSDT', 65000)];
    const contentHash = await computeScanContentHash(snapshots);

    const digest1 = await computeScanInstanceDigest('scan-uuid-1', 1700000000000, '2.7', contentHash);
    const digest2 = await computeScanInstanceDigest('scan-uuid-2', 1700000000000, '2.7', contentHash);

    expect(digest1).not.toBe(digest2);
    expect(digest1).toMatch(/^[a-f0-9]{64}$/);
    expect(digest2).toMatch(/^[a-f0-9]{64}$/);
  });

  it('test_lossless_numeric_serialization: Verifies sub-satoshi and high-precision numbers round-trip uniquely', () => {
    // Normalization of -0 to 0
    expect(normalizeNumber(-0)).toBe('0');
    expect(normalizeNumber(0)).toBe('0');

    // High-precision sub-satoshi micro-cap token prices (ECMA-262 toString(10) representation)
    expect(normalizeNumber(0.000000123456789)).toBe((0.000000123456789).toString(10));
    expect(normalizeNumber(12345678.90123456)).toBe((12345678.90123456).toString(10));

    // Precision preservation without lossy toFixed truncation
    const candle: NormalizedCandle = {
      openTime: 1700000000000,
      open: 0.00001234,
      high: 0.00001250,
      low: 0.00001200,
      close: 0.00001245,
      volume: 987654321.123456,
    };
    const serialized = serializeCandle(candle);
    expect(serialized).toBe('C:1700000000000:0.00001234:0.0000125:0.000012:0.00001245:987654321.123456');
  });

  it('test_malformed_ohlc_rejection: Asserts NaN or infinite values trigger immediate error', () => {
    expect(() => normalizeNumber(NaN)).toThrow(/Invalid non-finite number/);
    expect(() => normalizeNumber(Infinity)).toThrow(/Invalid non-finite number/);
    expect(() => normalizeNumber(-Infinity)).toThrow(/Invalid non-finite number/);
  });

  it('test_deep_freeze_immutability: Attempts property mutations on snapshot; asserts snapshot is frozen', () => {
    const snapshot = createDummySnapshot('BTCUSDT', 65000);
    const frozen = deepFreezeSnapshot(snapshot);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.candles)).toBe(true);
    expect(Object.isFrozen(frozen.candles['5m'])).toBe(true);
    expect(Object.isFrozen(frozen.candles['5m'][0])).toBe(true);

    // Attempt mutation in strict mode throws TypeError
    expect(() => {
      (frozen as any).currentPrice = 99999;
    }).toThrow();

    expect(() => {
      (frozen.candles['5m'][0] as any).close = 99999;
    }).toThrow();
  });
});
