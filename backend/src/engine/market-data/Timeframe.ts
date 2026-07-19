export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h';

const VALID_TIMEFRAMES = new Set<Timeframe>(['1m', '3m', '5m', '15m', '30m', '1h', '4h']);

export function isValidTimeframe(tf: string): tf is Timeframe {
  return VALID_TIMEFRAMES.has(tf as Timeframe);
}

export function parseTimeframe(tf: string): Timeframe {
  if (isValidTimeframe(tf)) {
    return tf;
  }
  throw new Error(`Invalid timeframe provided: ${tf}`);
}
