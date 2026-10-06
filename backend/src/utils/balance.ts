import BigNumber from 'bignumber.js';

/**
 * Safely extracts the authoritative USDT balance from an exchange balance result.
 * 
 * BybitAdapter.fetchBalance() returns Balance[]:
 *   [{ currency: 'USDT', free: BigNumber, used: BigNumber, total: BigNumber }]
 * 
 * Semantic Contract:
 * - 'total': Evaluates total account equity / NAV. Used for portfolio exposure limits,
 *            order sizing, and strategy execution context. If total is missing or invalid (<= 0),
 *            it returns defaultFallback (it does NOT silently reinterpret free as total).
 * - 'free':  Evaluates unencumbered available funds. Used explicitly for candidate discovery
 *            affordability checks. If free is missing or invalid (<= 0), it returns defaultFallback.
 * 
 * @param balanceResult Raw balance output from exchange adapter (Balance[] or legacy object)
 * @param defaultFallback Fallback amount when unparseable, absent, or invalid (default: 1000)
 * @param preference 'total' for portfolio equity/NAV, 'free' for available cash.
 */
export function extractUsdtBalance(
  balanceResult: any,
  defaultFallback: number = 1000,
  preference: 'total' | 'free' = 'total'
): number {
  if (!balanceResult) return defaultFallback;

  if (Array.isArray(balanceResult)) {
    const usdt = balanceResult.find((b: any) =>
      typeof b?.currency === 'string' && b.currency.toUpperCase() === 'USDT'
    );
    if (usdt) {
      if (preference === 'total') {
        const total = typeof usdt.total?.toNumber === 'function'
          ? usdt.total.toNumber()
          : (usdt.total instanceof BigNumber ? usdt.total.toNumber() : Number(usdt.total));
        if (typeof total === 'number' && !isNaN(total) && total > 0) {
          return total;
        }
        return defaultFallback;
      } else {
        const free = typeof usdt.free?.toNumber === 'function'
          ? usdt.free.toNumber()
          : (usdt.free instanceof BigNumber ? usdt.free.toNumber() : Number(usdt.free));
        if (typeof free === 'number' && !isNaN(free) && free > 0) {
          return free;
        }
        return defaultFallback;
      }
    }
  } else if (typeof balanceResult === 'object') {
    if (preference === 'total') {
      const total = balanceResult?.total?.USDT ?? balanceResult?.USDT?.total;
      if (typeof total === 'number' && !isNaN(total) && total > 0) {
        return total;
      }
      return defaultFallback;
    } else {
      const free = balanceResult?.free?.USDT ?? balanceResult?.USDT?.free;
      if (typeof free === 'number' && !isNaN(free) && free > 0) {
        return free;
      }
      return defaultFallback;
    }
  }

  return defaultFallback;
}
