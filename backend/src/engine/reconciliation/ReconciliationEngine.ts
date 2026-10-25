import { IExchangeProvider } from '../../exchanges/IExchangeProvider';
import { EconomicIntent } from '../wal/WalTypes';
import { UnifiedError } from '../../exchanges/models/UnifiedError';

export class ReconciliationEngine {
  private static readonly RECON_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  private static readonly MAX_ATTEMPTS = 4;

  private static mapExchangeStatusToIntentState(exchangeStatus: string): 'DISPATCHED' | 'PARTIALLY_FILLED' | 'FILLED' | 'FAILED' {
    switch (exchangeStatus) {
      case 'open':
        return 'DISPATCHED';
      case 'partially_filled':
        return 'PARTIALLY_FILLED';
      case 'closed':
        return 'FILLED';
      case 'canceled':
      case 'rejected':
        return 'FAILED';
      default:
        return 'DISPATCHED';
    }
  }

  private static isMonotonicProgression(oldStatus: string, newStatus: string): boolean {
    const ranks: Record<string, number> = {
      'UNKNOWN': 0,
      'RECONCILIATION_PENDING': 0,
      'INTENT_PERSISTED': 0,
      'PENDING_ENTRY': 0,
      'DISPATCHED': 1,
      'PARTIALLY_FILLED': 2,
      'FILLED': 3,
      'FAILED': 3,
      'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION': 3
    };
    const oldRank = ranks[oldStatus] || 0;
    const newRank = ranks[newStatus] || 0;
    return newRank >= oldRank;
  }

  public static async reconcile(
    adapter: IExchangeProvider,
    intent: EconomicIntent,
    currentTimeMs: number
  ): Promise<EconomicIntent> {
    const validStates = ['UNKNOWN', 'RECONCILIATION_PENDING', 'INTENT_PERSISTED', 'DISPATCHED', 'PARTIALLY_FILLED'];
    if (!validStates.includes(intent.status)) {
      return intent;
    }

    const previousStatus = intent.status;
    const previousExecutedQty = Number(intent.actualExecutedQuantity || 0);
    const previousAvgPrice = intent.actualFillPrice ? Number(intent.actualFillPrice) : null;

    intent.status = 'RECONCILIATION_PENDING';
    intent.reconciliationAttemptCount += 1;
    intent.lastReconciliationAttempt = currentTimeMs;

    try {
      // 1. Query Realtime using strictly Client Identity
      let order = await this.safeFetchOrder(adapter, intent.intentId, intent.symbol);
      
      if (!order) {
        // 2. Query History using strictly Client Identity
        order = await this.safeFetchHistory(adapter, intent.intentId, intent.symbol);
      }

      if (order) {
        // Exchange Found It exactly matching client ID!
        const proposedState = this.mapExchangeStatusToIntentState(order.status);
        
        // Monotonic progression check
        if (this.isMonotonicProgression(previousStatus, proposedState)) {
           intent.status = proposedState;
        } else {
           intent.status = previousStatus; // Reject regression
        }

        const rawFilledQty = typeof order.filled?.toNumber === 'function' ? order.filled.toNumber() : Number(order.filled || 0);
        intent.actualExecutedQuantity = Math.max(previousExecutedQty, rawFilledQty).toString(); // Monotonic quantity

        const rawAvgPrice = typeof order.average?.toNumber === 'function' ? order.average.toNumber() : Number(order.average || 0);
        if (rawFilledQty >= previousExecutedQty) {
            if (rawAvgPrice > 0) {
                intent.actualFillPrice = rawAvgPrice.toString(); // Sticky valid value
            } else if (previousAvgPrice !== null) {
                intent.actualFillPrice = previousAvgPrice.toString(); // Preserve old valid value if new is null/0
            }
        } else {
            if (previousAvgPrice !== null) {
                intent.actualFillPrice = previousAvgPrice.toString(); // Protect from stale regression
            }
        }

        if (order.id) intent.actualOrderId = order.id;

        // Lifecycle-Aware Exchange SL/TP Readback:
        // 1. Order-level protection readback (Working / Pre-Fill / Immediate Fill)
        let confirmedSL: number | null = typeof order.stopLoss?.toNumber === 'function'
          ? order.stopLoss.toNumber()
          : (order.stopLoss ? Number(order.stopLoss) : null);
        let confirmedTP: number | null = typeof order.takeProfit?.toNumber === 'function'
          ? order.takeProfit.toNumber()
          : (order.takeProfit ? Number(order.takeProfit) : null);

        // 2. Position-level protection readback (When Order status is Filled and position is active)
        if ((!confirmedSL || !confirmedTP) && (intent.status === 'FILLED' || intent.status === 'PARTIALLY_FILLED')) {
          try {
            if (typeof (adapter as any).fetchPositions === 'function') {
              const positions = await (adapter as any).fetchPositions();
              const { canonicalSymbol } = typeof (adapter as any).normalizeSymbol === 'function'
                ? (adapter as any).normalizeSymbol(intent.symbol)
                : { canonicalSymbol: intent.symbol };
              const normalizedIntentSide = (intent.side || '').toLowerCase();
              const targetSide = normalizedIntentSide === 'buy' ? 'long' : normalizedIntentSide === 'sell' ? 'short' : null;
              const matchedPos = positions?.find((p: any) => {
                const symMatch = p.symbol === canonicalSymbol || p.symbol === intent.symbol;
                if (!symMatch) return false;
                if (targetSide) {
                  return p.side?.toLowerCase() === targetSide || p.side?.toLowerCase() === normalizedIntentSide;
                }
                return true;
              });
              if (matchedPos) {
                const posSL = typeof matchedPos.stopLoss?.toNumber === 'function' ? matchedPos.stopLoss.toNumber() : (matchedPos.stopLoss ? Number(matchedPos.stopLoss) : null);
                const posTP = typeof matchedPos.takeProfit?.toNumber === 'function' ? matchedPos.takeProfit.toNumber() : (matchedPos.takeProfit ? Number(matchedPos.takeProfit) : null);
                if (posSL && posSL > 0) confirmedSL = posSL;
                if (posTP && posTP > 0) confirmedTP = posTP;
              }
            }
          } catch (posErr: any) {
            console.warn(`[RECONCILIATION] Fallback fetchPositions for SL/TP failed:`, posErr?.message || posErr);
          }
        }

        if (confirmedSL && confirmedSL > 0) {
          intent.exchangeConfirmedStopLoss = confirmedSL.toString();
        }
        if (confirmedTP && confirmedTP > 0) {
          intent.exchangeConfirmedTakeProfit = confirmedTP.toString();
        }

        return intent;
      }

      // If previous fill exists, an order cannot be "not found"
      if (previousExecutedQty > 0) {
        intent.status = 'PARTIALLY_FILLED';
        return intent;
      }

      // 3. Not Found (Exhaustive)
      const elapsedMs = currentTimeMs - intent.createdAt;
      
      if (elapsedMs >= this.RECON_WINDOW_MS && intent.reconciliationAttemptCount >= this.MAX_ATTEMPTS) {
        // Mandatory affirmative exchange evidence verification before declaring terminal release:
        // 1. Position on exchange MUST be verified flat (size == 0)
        // 2. No executable open orders exist on exchange for this symbol
        let isPositionFlat = false;
        let hasNoOpenOrders = false;

        try {
          if (typeof (adapter as any).fetchPositions === 'function') {
            const positions = await (adapter as any).fetchPositions(intent.payloadSnapshot?.category || 'linear');
            const { canonicalSymbol } = typeof (adapter as any).normalizeSymbol === 'function'
              ? (adapter as any).normalizeSymbol(intent.symbol)
              : { canonicalSymbol: intent.symbol };
            const normIntentSym = intent.symbol.replace(/[\/_-]/g, '').toUpperCase();
            const matchedPos = positions?.find((p: any) => {
              const normP = p.symbol ? p.symbol.replace(/[\/_-]/g, '').toUpperCase() : '';
              return normP === normIntentSym || p.symbol === canonicalSymbol || p.symbol === intent.symbol;
            });

            if (!matchedPos) {
              isPositionFlat = true;
            } else {
              const posSize = typeof matchedPos.size?.toNumber === 'function'
                ? matchedPos.size.toNumber()
                : Math.abs(Number(matchedPos.size || matchedPos.quantity || 0));
              isPositionFlat = posSize === 0;
            }
          } else {
            isPositionFlat = false; // Cannot verify -> fail closed
          }

          if (typeof (adapter as any).fetchOpenOrders === 'function') {
            const openOrders = await (adapter as any).fetchOpenOrders(intent.symbol);
            const normIntentSym = intent.symbol.replace(/[\/_-]/g, '').toUpperCase();
            const matchingOpen = openOrders?.find((o: any) =>
              o.clientOrderId === intent.intentId ||
              (o.symbol && o.symbol.replace(/[\/_-]/g, '').toUpperCase() === normIntentSym)
            );
            hasNoOpenOrders = !matchingOpen;
          } else {
            hasNoOpenOrders = true; // safeFetchOrder already checked open orders
          }

          if (isPositionFlat && hasNoOpenOrders) {
            intent.status = 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION';
            (intent as any).flatnessAffirmativelyVerified = true;
          } else {
            console.warn(`[RECONCILIATION] Retaining protection on ${intent.symbol}: affirmative flatness not proven (flat=${isPositionFlat}, noOpenOrders=${hasNoOpenOrders})`);
            intent.status = isPositionFlat ? 'UNKNOWN' : 'PARTIALLY_FILLED';
          }
        } catch (evidenceErr: any) {
          console.warn(`[RECONCILIATION] Evidence query failed for ${intent.symbol}, failing closed:`, evidenceErr?.message || evidenceErr);
          intent.status = 'UNKNOWN';
        }
      } else {
        intent.status = previousStatus === 'RECONCILIATION_PENDING' || previousStatus === 'UNKNOWN' ? 'UNKNOWN' : previousStatus;
      }

    } catch (err: any) {
      if (err instanceof UnifiedError && err.code === 'EXCHANGE_NOT_REACHABLE') {
        intent.reconciliationAttemptCount = Math.max(0, (intent.reconciliationAttemptCount || 1) - 1);
      }
      console.warn(`[RECONCILIATION] Exchange error for intent ${intent.intentId}:`, err.message);
      intent.status = previousStatus === 'RECONCILIATION_PENDING' || previousStatus === 'UNKNOWN' ? 'UNKNOWN' : previousStatus;
    }

    return intent;
  }

  private static isConnectivityError(err: any): boolean {
    if (!err) return false;
    if (err instanceof UnifiedError && (err.code === 'EXCHANGE_NOT_REACHABLE' || err.code === 'EXCHANGE_TIMEOUT' || err.code === 'NETWORK_ERROR')) {
      return true;
    }
    const msg = String(err.message || '').toLowerCase();
    const code = String(err.code || '').toUpperCase();
    return (
      code === 'EXCHANGE_NOT_REACHABLE' ||
      code === 'EXCHANGE_TIMEOUT' ||
      code === 'NETWORK_ERROR' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      msg.includes('exchange_not_reachable') ||
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('fetch failed') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('socket hang up')
    );
  }

  private static isOrderNotFoundError(err: any): boolean {
    if (!err) return false;
    if (err instanceof UnifiedError && err.code === 'ORDER_NOT_FOUND') {
      return true;
    }
    const msg = String(err.message || '').toLowerCase();
    const code = String(err.code || '').toUpperCase();
    return (
      code === 'ORDER_NOT_FOUND' ||
      err.httpStatus === 404 ||
      msg.includes('order not found') ||
      msg.includes('not found') ||
      msg.includes('does not exist') ||
      msg.includes('order not exists') ||
      msg.includes('too late to cancel')
    );
  }

  private static async safeFetchOrder(adapter: IExchangeProvider, intentId: string, symbol: string): Promise<any> {
    try {
      if (typeof adapter.fetchOrder !== 'function') {
        return null;
      }
      return await adapter.fetchOrder({ clientOrderId: intentId, symbol });
    } catch (err: any) {
      if (this.isConnectivityError(err)) {
        throw err;
      }
      if (this.isOrderNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  private static async safeFetchHistory(adapter: IExchangeProvider, intentId: string, symbol: string): Promise<any> {
    try {
      if (typeof adapter.fetchClosedOrders !== 'function') {
        return null;
      }
      const closed = await adapter.fetchClosedOrders(symbol);
      return closed?.find((o: any) => o.clientOrderId === intentId) || null;
    } catch (err: any) {
      if (this.isConnectivityError(err)) {
        throw err;
      }
      if (this.isOrderNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  public static async reconcilePositionLifecycle(
    adapter: any,
    dbPosition: any,
    currentTimeMs: number,
    knownClosed: boolean = false
  ): Promise<{ status: 'OPEN' | 'CLOSED'; closePrice?: number; realizedPnl?: number; closeReason?: string; closedAt?: string } | null> {
    if (!dbPosition || dbPosition.status === 'CLOSED' || dbPosition.status === 'CANCELLED') {
      return null; // Terminal states cannot regress
    }

    if (!adapter) {
      return null;
    }

    try {
      if (!knownClosed) {
        if (typeof adapter.fetchPositions !== 'function') {
          return null;
        }
        // 1. Query active positions from Bybit
        const activePositions = (await adapter.fetchPositions(dbPosition.category || 'linear')) || [];
        const normDbSymbol = dbPosition.symbol ? dbPosition.symbol.replace(/[\/_-]/g, '').toUpperCase() : '';
        const matchingActive = activePositions.find((p: any) => {
          const normP = p.symbol ? p.symbol.replace(/[\/_-]/g, '').toUpperCase() : '';
          return normP === normDbSymbol;
        });

        if (matchingActive && matchingActive.size && !matchingActive.size.isZero()) {
          return { status: 'OPEN' };
        }
      }

      // 2. Position is no longer open on exchange (size is 0). Query closed P&L records
      let closedPnlList: any[] = [];
      if (typeof adapter.fetchClosedPnl === 'function') {
        try {
          closedPnlList = (await adapter.fetchClosedPnl(dbPosition.symbol, dbPosition.category || 'linear')) || [];
        } catch (_) {}
      }

      if (closedPnlList && closedPnlList.length > 0) {
        const latestClosed = closedPnlList[0];
        let reason = 'exchange_close';
        if (latestClosed.execType === 'BustTrade') {
          reason = 'liquidation';
        } else if (latestClosed.orderType === 'Market' || latestClosed.execType === 'Trade') {
          const side = (dbPosition.side || 'BUY').toUpperCase();
          if (side === 'BUY') {
            if (dbPosition.take_profit && latestClosed.avgExitPrice >= dbPosition.take_profit * 0.999) {
              reason = 'take_profit';
            } else if (dbPosition.stop_loss && latestClosed.avgExitPrice <= dbPosition.stop_loss * 1.001) {
              reason = 'stop_loss';
            } else {
              reason = 'manual';
            }
          } else {
            if (dbPosition.take_profit && latestClosed.avgExitPrice <= dbPosition.take_profit * 1.001) {
              reason = 'take_profit';
            } else if (dbPosition.stop_loss && latestClosed.avgExitPrice >= dbPosition.stop_loss * 0.999) {
              reason = 'stop_loss';
            } else {
              reason = 'manual';
            }
          }
        }

        return {
          status: 'CLOSED',
          closePrice: latestClosed.avgExitPrice,
          realizedPnl: latestClosed.closedPnl,
          closeReason: reason,
          closedAt: new Date(latestClosed.updatedTime || currentTimeMs).toISOString()
        };
      }

      // 3. Fallback: check closed orders
      let closedOrders: any[] = [];
      if (typeof adapter.fetchClosedOrders === 'function') {
        try {
          closedOrders = (await adapter.fetchClosedOrders(dbPosition.symbol)) || [];
        } catch (_) {}
      }
      const exitOrder = closedOrders.find((o: any) => o.status === 'closed' && (o.side !== dbPosition.side?.toLowerCase()));
      if (exitOrder) {
        const exitAvg = exitOrder.average?.toNumber ? exitOrder.average.toNumber() : Number(exitOrder.average || 0);
        return {
          status: 'CLOSED',
          closePrice: exitAvg > 0 ? exitAvg : undefined,
          closeReason: 'exchange_close',
          closedAt: new Date(exitOrder.timestamp || currentTimeMs).toISOString()
        };
      }

      if (knownClosed) {
        return {
          status: 'CLOSED',
          closeReason: 'exchange_close',
          closedAt: new Date(currentTimeMs).toISOString()
        };
      }

      return null;
    } catch (err: any) {
      console.warn('[RECONCILIATION] Error reconciling position lifecycle:', err.message);
      return null;
    }
  }
}
