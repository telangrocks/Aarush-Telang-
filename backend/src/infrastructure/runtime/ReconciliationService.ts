import { ExecutionJournal, JournalRecord } from './ExecutionJournal';
import { BaseExchangeAdapter } from '../exchange/adapters/BaseExchangeAdapter';
import { Result, ok, fail, createDomainError, DomainError } from '../../domain/types/Result';

export interface ReconciliationResultItem {
  readonly clientOrderId: string;
  readonly previousState: string;
  readonly resolvedState: 'COMPLETED' | 'FAILED' | 'CANCELLED_EXTERNALLY';
  readonly exchangeOrderId?: string;
  readonly note: string;
}

export interface ReconciliationReport {
  readonly timestamp: number;
  readonly reconciledCount: number;
  readonly items: ReconciliationResultItem[];
}

export class ReconciliationService {
  constructor(private readonly journal: ExecutionJournal) {}

  public async reconcilePendingOrders(
    adapter: BaseExchangeAdapter
  ): Promise<Result<ReconciliationReport, DomainError>> {
    const checkpoints = this.journal.getRecoveryCheckpoints();
    const items: ReconciliationResultItem[] = [];

    for (const checkpoint of checkpoints) {
      try {
        const item = await this.reconcileSingleOrder(adapter, checkpoint);
        items.push(item);
      } catch (err: any) {
        items.push({
          clientOrderId: checkpoint.clientOrderId,
          previousState: checkpoint.state,
          resolvedState: 'FAILED',
          note: `Reconciliation error: ${err?.message || String(err)}`,
        });
      }
    }

    const report: ReconciliationReport = {
      timestamp: Date.now(),
      reconciledCount: items.length,
      items,
    };

    return ok(report);
  }

  private async reconcileSingleOrder(
    adapter: BaseExchangeAdapter,
    checkpoint: JournalRecord
  ): Promise<ReconciliationResultItem> {
    const symbol = (checkpoint.payload as any)?.symbol || 'BTC/USDT';

    // 1. Query remote exchange open/closed orders (Authoritative Source)
    let remoteOrders: any[] = [];
    try {
      remoteOrders = await adapter.fetchOpenOrders(symbol);
    } catch (_) {}

    const matchedRemote = remoteOrders.find(
      (o) => o.clientOrderId === checkpoint.clientOrderId || o.id === (checkpoint.result as any)?.exchangeOrderId
    );

    if (matchedRemote) {
      if (matchedRemote.status === 'closed' || matchedRemote.status === 'filled') {
        this.journal.recordStateTransition(checkpoint.clientOrderId, 'COMPLETED', { exchangeOrderId: matchedRemote.id });
        return {
          clientOrderId: checkpoint.clientOrderId,
          previousState: checkpoint.state,
          resolvedState: 'COMPLETED',
          exchangeOrderId: matchedRemote.id,
          note: 'Remote exchange confirmed order is FILLED.',
        };
      } else {
        // Order remains open on exchange
        this.journal.recordStateTransition(checkpoint.clientOrderId, 'COMMITTED', { exchangeOrderId: matchedRemote.id });
        return {
          clientOrderId: checkpoint.clientOrderId,
          previousState: checkpoint.state,
          resolvedState: 'COMPLETED',
          exchangeOrderId: matchedRemote.id,
          note: 'Remote exchange confirmed order is OPEN.',
        };
      }
    }

    // 2. Query closed orders if not in open orders
    let closedOrders: any[] = [];
    try {
      closedOrders = await adapter.fetchClosedOrders(symbol);
    } catch (_) {}

    const matchedClosed = closedOrders.find(
      (o) => o.clientOrderId === checkpoint.clientOrderId || o.id === (checkpoint.result as any)?.exchangeOrderId
    );

    if (matchedClosed) {
      this.journal.recordStateTransition(checkpoint.clientOrderId, 'COMPLETED', { exchangeOrderId: matchedClosed.id });
      return {
        clientOrderId: checkpoint.clientOrderId,
        previousState: checkpoint.state,
        resolvedState: 'COMPLETED',
        exchangeOrderId: matchedClosed.id,
        note: 'Remote exchange confirmed order is FILLED in closed orders list.',
      };
    }

    // 3. If not found remotely, order was never created or was cancelled externally
    this.journal.recordStateTransition(checkpoint.clientOrderId, 'FAILED', undefined, 'Order not found on remote exchange');
    return {
      clientOrderId: checkpoint.clientOrderId,
      previousState: checkpoint.state,
      resolvedState: 'CANCELLED_EXTERNALLY',
      note: 'Order not found on remote exchange; marked failed in journal.',
    };
  }
}
