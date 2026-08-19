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

        return intent;
      }

      // 3. Not Found (Exhaustive)
      const elapsedMs = currentTimeMs - intent.createdAt;
      
      if (elapsedMs >= this.RECON_WINDOW_MS && intent.reconciliationAttemptCount >= this.MAX_ATTEMPTS) {
        intent.status = 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION';
      } else {
        intent.status = previousStatus === 'RECONCILIATION_PENDING' || previousStatus === 'UNKNOWN' ? 'UNKNOWN' : previousStatus;
      }

    } catch (err: any) {
      console.warn(`[RECONCILIATION] Exchange error for intent ${intent.intentId}:`, err.message);
      intent.status = previousStatus === 'RECONCILIATION_PENDING' || previousStatus === 'UNKNOWN' ? 'UNKNOWN' : previousStatus;
    }

    return intent;
  }

  private static async safeFetchOrder(adapter: IExchangeProvider, intentId: string, symbol: string): Promise<any> {
    try {
      return await adapter.fetchOrder({ clientOrderId: intentId, symbol });
    } catch (err: any) {
      if (err instanceof UnifiedError && (err.code === 'EXCHANGE_NOT_REACHABLE' || err.code === 'ORDER_NOT_FOUND' || err.message.includes('not found') || err.message.toLowerCase().includes('does not exist'))) {
        return null;
      }
      throw err;
    }
  }

  private static async safeFetchHistory(adapter: IExchangeProvider, intentId: string, symbol: string): Promise<any> {
    try {
       const closed = await adapter.fetchClosedOrders(symbol);
       return closed.find((o: any) => o.clientOrderId === intentId) || null;
    } catch (err: any) {
      if (err instanceof UnifiedError && (err.code === 'EXCHANGE_NOT_REACHABLE' || err.code === 'ORDER_NOT_FOUND' || err.message.includes('not found'))) {
        return null;
      }
      throw err;
    }
  }
}
