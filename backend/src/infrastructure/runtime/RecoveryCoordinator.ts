import { ResilientWebSocketManager } from './WebSocketManager';
import { ReconciliationService, ReconciliationReport } from './ReconciliationService';
import { HealthMonitor } from './HealthMonitor';
import { EventBus, DomainEvent } from '../../domain/events/EventBus';
import { BaseExchangeAdapter } from '../exchange/adapters/BaseExchangeAdapter';
import { Result, ok, fail, createDomainError, DomainError } from '../../domain/types/Result';
import { RecoveryReason } from './RuntimeState';

export class RecoveryCompletedEvent implements DomainEvent {
  readonly eventId = crypto.randomUUID();
  readonly timestamp = Date.now();
  readonly eventType = 'RECOVERY_COMPLETED';
  constructor(
    readonly exchangeId: string,
    readonly reason: RecoveryReason,
    readonly reconciledOrdersCount: number
  ) {}
}

export class RecoveryCoordinator {
  constructor(
    private readonly healthMonitor: HealthMonitor,
    private readonly reconciliationService: ReconciliationService,
    private readonly eventBus: EventBus
  ) {}

  public async executeSelfHealingRecovery(
    adapter: BaseExchangeAdapter,
    reason: RecoveryReason,
    wsManager?: ResilientWebSocketManager
  ): Promise<Result<{ exchangeId: string; reconciliationReport?: ReconciliationReport }, DomainError>> {
    const exchangeId = adapter.exchangeId;

    try {
      // 1. Reconnect WebSocket if provided
      if (wsManager) {
        wsManager.simulateReconnectAndResubscribe();
      }

      // 2. Reconcile pending orders against remote exchange (Authoritative Source)
      const reconResult = await this.reconciliationService.reconcilePendingOrders(adapter);
      const reconReport = reconResult.isSuccess ? reconResult.value : undefined;

      // 3. Reset & evaluate health monitor state
      this.healthMonitor.recordSuccess(exchangeId);

      // 4. Publish async Domain Event
      await this.eventBus.publish(
        new RecoveryCompletedEvent(exchangeId, reason, reconReport ? reconReport.reconciledCount : 0)
      );

      return ok({
        exchangeId,
        reconciliationReport: reconReport,
      });
    } catch (err: any) {
      this.healthMonitor.recordFailure(exchangeId, err);
      return fail(createDomainError('INTERNAL_ERROR', `Self-healing recovery failed for ${exchangeId}: ${err?.message || String(err)}`));
    }
  }
}
