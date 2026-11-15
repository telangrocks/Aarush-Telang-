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
 * @param defaultFallback Fallback amount when unparseable, absent, or invalid (default: 0)
 * @param preference 'total' for portfolio equity/NAV, 'free' for available cash.
 */
export function extractUsdtBalance(
  balanceResult: any,
  defaultFallback: number = 0,
  preference: 'total' | 'free' = 'total'
): number {
  const safeFallback =
    typeof defaultFallback === 'number' && Number.isFinite(defaultFallback) && defaultFallback > 0
      ? defaultFallback
      : 0;
  if (!balanceResult) return safeFallback;

  if (Array.isArray(balanceResult)) {
    const usdt = balanceResult.find((b: any) =>
      typeof b?.currency === 'string' && b.currency.toUpperCase() === 'USDT'
    );
    if (usdt) {
      if (preference === 'total') {
        const total = typeof usdt.total?.toNumber === 'function'
          ? usdt.total.toNumber()
          : (usdt.total instanceof BigNumber ? usdt.total.toNumber() : Number(usdt.total));
        if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
          return total;
        }
        return safeFallback;
      } else {
        const free = typeof usdt.free?.toNumber === 'function'
          ? usdt.free.toNumber()
          : (usdt.free instanceof BigNumber ? usdt.free.toNumber() : Number(usdt.free));
        if (typeof free === 'number' && Number.isFinite(free) && free > 0) {
          return free;
        }
        return safeFallback;
      }
    }
  } else if (typeof balanceResult === 'object') {
    if (preference === 'total') {
      const total = balanceResult?.total?.USDT ?? balanceResult?.USDT?.total;
      if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
        return total;
      }
      return safeFallback;
    } else {
      const free = balanceResult?.free?.USDT ?? balanceResult?.USDT?.free;
      if (typeof free === 'number' && Number.isFinite(free) && free > 0) {
        return free;
      }
      return safeFallback;
    }
  }

  return safeFallback;
}
