import { describe, it, expect } from 'vitest';
import { HealthMonitor } from './HealthMonitor';
import { ExecutionJournal } from './ExecutionJournal';
import { ReconciliationService } from './ReconciliationService';
import { EventBus } from '../../domain/events/EventBus';
import { RecoveryCoordinator, RecoveryCompletedEvent } from './RecoveryCoordinator';
import { BybitAdapter } from '../exchange/adapters/BybitAdapter';
import { ResilientWebSocketManager } from './WebSocketManager';
import { MockExchangeSocketAdapter } from './adapters/ExchangeSocketAdapter';

describe('Milestone 8 — RecoveryCoordinator Pure Orchestration Unit Tests', () => {
  it('RecoveryCoordinator orchestrates WebSocket reconnect, order reconciliation, and event dispatch', async () => {
    const health = new HealthMonitor();
    const journal = new ExecutionJournal();
    const reconService = new ReconciliationService(journal);
    const bus = new EventBus();
    const coordinator = new RecoveryCoordinator(health, reconService, bus);

    let eventDispatched = false;
    bus.subscribe<RecoveryCompletedEvent>('RECOVERY_COMPLETED', (evt) => {
      eventDispatched = true;
      expect(evt.exchangeId).toBe('binance');
      expect(evt.reason).toBe('WEBSOCKET_DISCONNECT');
    });

    const adapter = new BybitAdapter();
    adapter.fetchOpenOrders = async () => [];
    adapter.fetchClosedOrders = async () => [];

    const wsAdapter = new MockExchangeSocketAdapter();
    const wsManager = new ResilientWebSocketManager(wsAdapter);
    wsManager.subscribe(['ticker.BTCUSDT']); // Register topic subscription

    const res = await coordinator.executeSelfHealingRecovery(adapter, 'WEBSOCKET_DISCONNECT', wsManager);

    expect(res.isSuccess).toBe(true);
    expect(eventDispatched).toBe(true);
    expect(wsManager.getState()).toBe('RECEIVING');
    expect(health.evaluateHealth('binance').healthScore).toBe(100);
  });
});
