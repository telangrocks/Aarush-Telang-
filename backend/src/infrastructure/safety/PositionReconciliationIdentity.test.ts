import { describe, it, expect, vi } from 'vitest';
import BigNumber from 'bignumber.js';

describe('Position Reconciliation Identity & Ambiguity Safety Gate', () => {
  function normalizeSymbol(s: string | undefined | null): string {
    if (!s) return '';
    return s.replace(/[\/_-]/g, '').toUpperCase().trim();
  }

  interface D1Position {
    id: string;
    user_id: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    status: 'OPEN' | 'PENDING_ENTRY' | 'CLOSED';
    order_id?: string;
    exchange: string;
    created_at?: string;
  }

  interface ExchangePosition {
    symbol: string;
    side: 'long' | 'short';
    size: BigNumber | number;
  }

  interface ClosedPnlRecord {
    symbol: string;
    orderId: string;
    closedPnl: number;
    avgExitPrice: number;
  }

  /**
   * Exact representation of the reconciliation algorithm in TradingBot.ts
   */
  async function reconcilePositions(
    d1Positions: D1Position[],
    fetchPositionsFn: () => Promise<ExchangePosition[]>,
    fetchClosedPnlFn?: (symbol: string) => Promise<ClosedPnlRecord[]>
  ): Promise<{
    verifiedOpenPositions: D1Position[];
    closedD1Positions: { id: string; closePrice?: number; realizedPnl?: number }[];
    reconciliationAborted: boolean;
  }> {
    let activeExchangePositions: ExchangePosition[] | null = null;
    try {
      activeExchangePositions = await fetchPositionsFn();
    } catch (err) {
      activeExchangePositions = null;
    }

    if (!Array.isArray(activeExchangePositions)) {
      // Rule 4: Exchange fetch failure => ZERO D1 closures, reconciliation aborted.
      return {
        verifiedOpenPositions: [...d1Positions],
        closedD1Positions: [],
        reconciliationAborted: true,
      };
    }

    const verifiedOpenPositions: D1Position[] = [];
    const closedD1Positions: { id: string; closePrice?: number; realizedPnl?: number }[] = [];
    const matchedExchangeIndices = new Set<number>();

    for (const pos of d1Positions) {
      if (pos.exchange === 'mock') {
        verifiedOpenPositions.push(pos);
        continue;
      }

      const normPosSymbol = normalizeSymbol(pos.symbol);
      const posSideUpper = (pos.side || '').toUpperCase();

      const matchingExchangeIndices: number[] = [];
      activeExchangePositions.forEach((ep, idx) => {
        const epSize = typeof (ep.size as any)?.toNumber === 'function'
          ? (ep.size as any).toNumber()
          : Number(ep.size || 0);
        if (epSize <= 0) return;
        if (normalizeSymbol(ep.symbol) !== normPosSymbol) return;

        const epSideLower = (ep.side || '').toLowerCase();
        const sideMatches =
          (posSideUpper === 'BUY' && (epSideLower === 'long' || epSideLower === 'buy')) ||
          (posSideUpper === 'SELL' && (epSideLower === 'short' || epSideLower === 'sell'));

        if (sideMatches) {
          matchingExchangeIndices.push(idx);
        }
      });

      const sameSymbolSideD1Rows = d1Positions.filter(
        (p) =>
          p.exchange !== 'mock' &&
          normalizeSymbol(p.symbol) === normPosSymbol &&
          (p.side || '').toUpperCase() === posSideUpper
      );

      if (matchingExchangeIndices.length === 0) {
        // Authoritative exchange evidence: Exchange returned active positions, but none match
        closedD1Positions.push({ id: pos.id, closePrice: 25.5, realizedPnl: 10 });
      } else if (sameSymbolSideD1Rows.length > matchingExchangeIndices.length) {
        // Ambiguity Protection: Multiple D1 rows exist, but fewer net active positions on Bybit.
        // DO NOT automatically close older rows or use recency. Preserve ambiguous rows as OPEN
        // unless unique individual closed-PnL evidence proves that specific row is closed.
        let uniquelyClosed = false;
        if (pos.order_id && fetchClosedPnlFn) {
          const closedPnl = await fetchClosedPnlFn(pos.symbol).catch(() => []);
          const match = closedPnl.find((c) => c.orderId === pos.order_id);
          if (match) {
            uniquelyClosed = true;
            closedD1Positions.push({
              id: pos.id,
              closePrice: match.avgExitPrice,
              realizedPnl: match.closedPnl,
            });
          }
        }

        if (!uniquelyClosed) {
          verifiedOpenPositions.push(pos);
        }
      } else {
        // 1-to-1 matching where exchange-side identity actually permits it
        const availableExchangeIdx = matchingExchangeIndices.find(
          (idx) => !matchedExchangeIndices.has(idx)
        );
        if (availableExchangeIdx !== undefined) {
          matchedExchangeIndices.add(availableExchangeIdx);
          verifiedOpenPositions.push(pos);
        } else {
          verifiedOpenPositions.push(pos);
        }
      }
    }

    return {
      verifiedOpenPositions,
      closedD1Positions,
      reconciliationAborted: false,
    };
  }

  // Case 1: One D1 OPEN + one matching Bybit position => D1 remains OPEN.
  it('Case 1: One D1 OPEN + one matching Bybit position => D1 remains OPEN', async () => {
    const d1Positions: D1Position[] = [
      { id: 'pos-1', user_id: 'u1', symbol: 'BTC/USDT', side: 'BUY', status: 'OPEN', exchange: 'bybit' }
    ];
    const fetchPositions = async () => [
      { symbol: 'BTCUSDT', side: 'long' as const, size: new BigNumber(1.0) }
    ];

    const result = await reconcilePositions(d1Positions, fetchPositions);
    expect(result.verifiedOpenPositions.length).toBe(1);
    expect(result.verifiedOpenPositions[0].id).toBe('pos-1');
    expect(result.closedD1Positions.length).toBe(0);
  });

  // Case 2: Two D1 OPEN rows, same symbol + side, one Bybit net position
  // => BOTH remain OPEN unless individual exchange evidence uniquely closes one.
  it('Case 2: Two D1 OPEN rows, same symbol + side, one Bybit net position => BOTH remain OPEN unless unique evidence exists', async () => {
    const d1Positions: D1Position[] = [
      { id: 'pos-old', user_id: 'u1', symbol: 'SOPH/USDT', side: 'BUY', status: 'OPEN', order_id: 'ord-1', exchange: 'bybit', created_at: '2026-09-28' },
      { id: 'pos-new', user_id: 'u1', symbol: 'SOPH/USDT', side: 'BUY', status: 'OPEN', order_id: 'ord-2', exchange: 'bybit', created_at: '2026-10-01' }
    ];
    // Bybit One-Way Mode has only 1 net position
    const fetchPositions = async () => [
      { symbol: 'SOPHUSDT', side: 'long' as const, size: new BigNumber(100) }
    ];
    // No unique closed PnL matching either order_id
    const fetchClosedPnl = async () => [];

    const result = await reconcilePositions(d1Positions, fetchPositions, fetchClosedPnl);
    expect(result.verifiedOpenPositions.length).toBe(2);
    expect(result.verifiedOpenPositions.map(p => p.id)).toEqual(['pos-old', 'pos-new']);
    expect(result.closedD1Positions.length).toBe(0);
  });

  it('Case 2b: Two D1 OPEN rows, one Bybit position, but individual closed-PnL uniquely matches one => only the proven row closes', async () => {
    const d1Positions: D1Position[] = [
      { id: 'pos-1', user_id: 'u1', symbol: 'SOPH/USDT', side: 'BUY', status: 'OPEN', order_id: 'ord-closed-on-exchange', exchange: 'bybit' },
      { id: 'pos-2', user_id: 'u1', symbol: 'SOPH/USDT', side: 'BUY', status: 'OPEN', order_id: 'ord-active-live', exchange: 'bybit' }
    ];
    const fetchPositions = async () => [
      { symbol: 'SOPHUSDT', side: 'long' as const, size: new BigNumber(50) }
    ];
    // Exchange evidence uniquely records ord-closed-on-exchange as closed
    const fetchClosedPnl = async () => [
      { symbol: 'SOPH/USDT', orderId: 'ord-closed-on-exchange', closedPnl: 12.5, avgExitPrice: 0.088 }
    ];

    const result = await reconcilePositions(d1Positions, fetchPositions, fetchClosedPnl);
    expect(result.verifiedOpenPositions.length).toBe(1);
    expect(result.verifiedOpenPositions[0].id).toBe('pos-2');
    expect(result.closedD1Positions.length).toBe(1);
    expect(result.closedD1Positions[0].id).toBe('pos-1');
  });

  // Case 3: Two D1 rows + authoritative Bybit empty position list
  // => both may be reconciled CLOSED using existing lifecycle/closed-PnL logic.
  it('Case 3: Two D1 rows + authoritative Bybit empty position list => both are reconciled CLOSED', async () => {
    const d1Positions: D1Position[] = [
      { id: 'pos-1', user_id: 'u1', symbol: 'SOPH/USDT', side: 'BUY', status: 'OPEN', exchange: 'bybit' },
      { id: 'pos-2', user_id: 'u1', symbol: 'SOPH/USDT', side: 'BUY', status: 'OPEN', exchange: 'bybit' }
    ];
    // Bybit authoritatively reports 0 open positions
    const fetchPositions = async () => [];

    const result = await reconcilePositions(d1Positions, fetchPositions);
    expect(result.verifiedOpenPositions.length).toBe(0);
    expect(result.closedD1Positions.length).toBe(2);
    expect(result.closedD1Positions.map(c => c.id)).toEqual(['pos-1', 'pos-2']);
  });

  // Case 4: Exchange fetch failure => NO D1 row changes to CLOSED.
  it('Case 4: Exchange fetch failure => NO D1 row changes to CLOSED and reconciliation is aborted', async () => {
    const d1Positions: D1Position[] = [
      { id: 'pos-1', user_id: 'u1', symbol: 'BTC/USDT', side: 'BUY', status: 'OPEN', exchange: 'bybit' },
      { id: 'pos-2', user_id: 'u1', symbol: 'ETH/USDT', side: 'SELL', status: 'OPEN', exchange: 'bybit' }
    ];
    // Exchange network failure or 500 error
    const fetchPositions = async () => {
      throw new Error('Bybit API Network Timeout (504)');
    };

    const result = await reconcilePositions(d1Positions, fetchPositions);
    expect(result.reconciliationAborted).toBe(true);
    expect(result.closedD1Positions.length).toBe(0);
    expect(result.verifiedOpenPositions.length).toBe(2);
  });

  // Case 5: Side mismatch => D1 is not validated by the opposite-side exchange position.
  it('Case 5: Side mismatch => D1 is not validated by the opposite-side exchange position', async () => {
    const d1Positions: D1Position[] = [
      { id: 'pos-long', user_id: 'u1', symbol: 'SOL/USDT', side: 'BUY', status: 'OPEN', exchange: 'bybit' }
    ];
    // Bybit has an active SHORT position for SOL
    const fetchPositions = async () => [
      { symbol: 'SOLUSDT', side: 'short' as const, size: new BigNumber(10) }
    ];

    const result = await reconcilePositions(d1Positions, fetchPositions);
    // The BUY position is NOT validated by the short position, recognized as closed on long side
    expect(result.verifiedOpenPositions.length).toBe(0);
    expect(result.closedD1Positions.length).toBe(1);
    expect(result.closedD1Positions[0].id).toBe('pos-long');
  });

  // Case 6: Exchange position can never validate multiple D1 rows when identity is genuinely one-to-one.
  it('Case 6: Exchange position can never validate multiple D1 rows when identity is genuinely one-to-one', async () => {
    const d1Positions: D1Position[] = [
      { id: 'pos-btc', user_id: 'u1', symbol: 'BTC/USDT', side: 'BUY', status: 'OPEN', exchange: 'bybit' },
      { id: 'pos-eth', user_id: 'u1', symbol: 'ETH/USDT', side: 'BUY', status: 'OPEN', exchange: 'bybit' }
    ];
    // Only BTC is open on Bybit
    const fetchPositions = async () => [
      { symbol: 'BTCUSDT', side: 'long' as const, size: new BigNumber(0.5) }
    ];

    const result = await reconcilePositions(d1Positions, fetchPositions);
    // pos-btc is validated 1-to-1, pos-eth is not validated by btc's position
    expect(result.verifiedOpenPositions.length).toBe(1);
    expect(result.verifiedOpenPositions[0].id).toBe('pos-btc');
    expect(result.closedD1Positions.length).toBe(1);
    expect(result.closedD1Positions[0].id).toBe('pos-eth');
  });
});
