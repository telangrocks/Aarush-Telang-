/**
 * Opportunity Identity Generator
 *
 * Deterministic formula:
 * OPP_${symbol}_${direction}_${firstBarClosedTimestamp}
 */
export function generateOpportunityId(
  symbol: string,
  direction: 'BUY' | 'SELL',
  firstBarClosedTimestamp: number
): string {
  const normSymbol = (symbol || '').trim().toUpperCase();
  const normDirection = (direction || '').trim().toUpperCase() as 'BUY' | 'SELL';
  const ts = Math.floor(Number(firstBarClosedTimestamp) || 0);

  return `OPP_${normSymbol}_${normDirection}_${ts}`;
}
