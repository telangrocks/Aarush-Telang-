/**
 * Observation Identity Generator
 *
 * Deterministic formula:
 * OBS_${symbol}_${timeframe}_${strategyId}_${closedCandleTimestamp}
 */
export function generateObservationId(
  symbol: string,
  timeframe: string,
  strategyId: string,
  closedCandleTimestamp: number
): string {
  const normSymbol = (symbol || '').trim().toUpperCase();
  const normTimeframe = (timeframe || '').trim();
  const normStrategyId = (strategyId || '').trim();
  const ts = Math.floor(Number(closedCandleTimestamp) || 0);

  return `OBS_${normSymbol}_${normTimeframe}_${normStrategyId}_${ts}`;
}
