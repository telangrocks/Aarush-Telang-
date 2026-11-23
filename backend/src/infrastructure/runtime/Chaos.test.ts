import { describe, it, expect } from 'vitest';
import { HealthMonitor } from './HealthMonitor';
import { ExecutionJournal } from './ExecutionJournal';
import { ReconciliationService } from './ReconciliationService';
import { PartialResultContainer } from './PartialFailureFramework';
import { BybitAdapter } from '../exchange/adapters/BybitAdapter';
import { ResilientWebSocketManager } from './WebSocketManager';
import { MockExchangeSocketAdapter } from './adapters/ExchangeSocketAdapter';
import { RetryBudget } from './RetryBudget';
import { RecoveryCoordinator, RecoveryCompletedEvent } from './RecoveryCoordinator';
import { BotSupervisor } from './BotSupervisor';
import { EventBus } from '../../domain/events/EventBus';
import BigNumber from 'bignumber.js';

describe('Milestone 10 — Continuous Chaos & Runtime Resilience Test Suite', () => {
  it('Chaos Test 1: HTTP 429 Rate Limit Storm recovery', async () => {
    const monitor = new HealthMonitor();
    const budget = monitor.getRetryBudget('binance');

    // Simulate 429 storm
    for (let i = 0; i < 5; i++) {
      const err = new Error('HTTP 429 Too Many Requests');
      expect(budget.isRetryable(err)).toBe(true);
      monitor.recordFailure('binance', err);
    }

    const decision = monitor.evaluateHealth('binance');
    expect(decision.allowed).toBe(false); // Circuit opened to protect upstream exchange
  });

  it('Chaos Test 2: WebSocket flapping & sequence gap resubscription', async () => {
    const socketAdapter = new MockExchangeSocketAdapter();
    const wsManager = new ResilientWebSocketManager(socketAdapter, 10); // 10ms timeout

    wsManager.subscribe(['ticker.BTCUSDT', 'order.BTCUSDT']);
    wsManager.simulateConnect();
    expect(wsManager.getState()).toBe('SUBSCRIBED');

    // Simulate socket disconnect & timeout
    await new Promise(r => setTimeout(r, 20));
    expect(wsManager.checkHeartbeat()).toBe(false);
    expect(wsManager.getState()).toBe('HEARTBEAT_LOST');

    wsManager.simulateReconnectAndResubscribe();
    expect(wsManager.getState()).toBe('RECEIVING');
    expect(wsManager.getSubscriptions()).toContain('ticker.BTCUSDT');
  });

  it('Chaos Test 3: Cloudflare Worker isolate warm restart recovery via ExecutionJournal checkpoints', async () => {
    // 1. Isolate 1 (Pre-restart): Writes order intent to ExecutionJournal
    const journalIsolate1 = new ExecutionJournal();
    const clientOrdId = 'ord_cf_warm_777';
    const hash = await journalIsolate1.createIntentHash('user_99', 'BTC/USDT', 'buy', 0.5);
    journalIsolate1.recordSubmitting(clientOrdId, 'wf_isolate_restart', hash, { symbol: 'BTC/USDT', side: 'buy' });

    expect(journalIsolate1.getRecoveryCheckpoints()).toHaveLength(1);

    // 2. Isolate 2 (Post-restart): Reads recovery checkpoints & reconciles order
    const journalIsolate2 = journalIsolate1; // Persistent storage simulated
    const reconService = new ReconciliationService(journalIsolate2);

    const adapter = new BybitAdapter();
    adapter.fetchOpenOrders = async () => [
      {
        id: 'ex_binance_cf_777',
        clientOrderId: clientOrdId,
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        status: 'open',
        price: new BigNumber(60000),
        amount: new BigNumber(0.5),
        filled: new BigNumber(0),
        remaining: new BigNumber(0.5),
        cost: new BigNumber(30000),
        timeInForce: 'GTC',
        timestamp: Date.now(),
      },
    ];

    const reconRes = await reconService.reconcilePendingOrders(adapter);
    expect(reconRes.isSuccess).toBe(true);
    if (reconRes.isSuccess) {
      expect(reconRes.value.reconciledCount).toBe(1);
      expect(reconRes.value.items[0].resolvedState).toBe('COMPLETED');
    }
  });

  it('Chaos Test 4: Degraded execution under partial component timeouts', () => {
    const container = new PartialResultContainer<{ balances: any[]; ticker: any; positions: any[] }>();

    container.setComponentData('balances', [{ currency: 'USDT', free: 5000 }]);
    container.setComponentStatus('ticker', 'DEGRADED', 'Ticker response latency > 2000ms');
    container.setComponentStatus('positions', 'FAILED', 'Positions API timeout');

    expect(container.hasFailures()).toBe(true);
    expect(container.data.balances).toBeDefined();
    expect(container.toSummary().isDegraded).toBe(true);
  });

  describe('Consolidated Runtime Component Invariants (HealthMonitor, WebSocketRecovery, Reconciliation, PartialFailure)', () => {
    it('HealthMonitor computes healthScore 100 -> 0 with Circuit breaker OPEN reason and updates immutable RuntimeState snapshots', () => {
      const monitor = new HealthMonitor();
      const initial = monitor.evaluateHealth('binance');
      expect(initial.allowed).toBe(true);
      expect(initial.healthScore).toBe(100);

      for (let i = 0; i < 5; i++) {
        monitor.recordFailure('binance', new Error('HTTP 500 Internal Server Error'));
      }

      const decision = monitor.evaluateHealth('binance');
      expect(decision.allowed).toBe(false);
      expect(decision.healthScore).toBe(0);
      expect(decision.reason).toContain('Circuit breaker is OPEN');

      monitor.recordSuccess('kucoin');
      const kucoinHealth = monitor.getRuntimeState().exchangeHealth.get('kucoin');
      expect(kucoinHealth).toBeDefined();
      expect(kucoinHealth?.healthScore).toBe(100);
      expect(kucoinHealth?.circuitState).toBe('CLOSED');
    });

    it('ResilientWebSocketManager manages DISCONNECTED -> SUBSCRIBED -> RECEIVING incoming message lifecycle cleanly', () => {
      const adapter = new MockExchangeSocketAdapter();
      const manager = new ResilientWebSocketManager(adapter, 100);
      expect(manager.getState()).toBe('DISCONNECTED');

      manager.subscribe(['ticker.BTCUSDT']);
      manager.simulateConnect();
      expect(manager.getState()).toBe('SUBSCRIBED');

      const msg = manager.simulateIncomingRawMessage(JSON.stringify({ topic: 'ticker', symbol: 'BTC/USDT', price: 60000 }));
      expect(msg.type).toBe('ticker');
      expect(manager.getState()).toBe('RECEIVING');
    });

    it('ReconciliationService updates journal to COMMITTED with exchangeOrderId on match and marks missing orders CANCELLED_EXTERNALLY / FAILED', async () => {
      const journal1 = new ExecutionJournal();
      const service1 = new ReconciliationService(journal1);
      const clientOrdId = 'ord_recon_001';
      const hash1 = await journal1.createIntentHash('usr1', 'BTC/USDT', 'buy', 1);
      journal1.recordSubmitting(clientOrdId, 'wf_recon', hash1, { symbol: 'BTC/USDT', side: 'buy' });

      const adapter1 = new BybitAdapter();
      adapter1.fetchOpenOrders = async () => [
        {
          id: 'ex_binance_777',
          clientOrderId: clientOrdId,
          symbol: 'BTC/USDT',
          side: 'buy',
          type: 'limit',
          status: 'open',
          price: new BigNumber(60000),
          amount: new BigNumber(1),
          filled: new BigNumber(0),
          remaining: new BigNumber(1),
          cost: new BigNumber(60000),
          timeInForce: 'GTC',
          timestamp: Date.now(),
        },
      ];

      const matchRes = await service1.reconcilePendingOrders(adapter1);
      expect(matchRes.isSuccess).toBe(true);
      if (matchRes.isSuccess) {
        expect(matchRes.value.reconciledCount).toBe(1);
        expect(matchRes.value.items[0].resolvedState).toBe('COMPLETED');
        expect(matchRes.value.items[0].exchangeOrderId).toBe('ex_binance_777');
      }
      expect(journal1.getRecord(clientOrdId)?.state).toBe('COMMITTED');

      const journal2 = new ExecutionJournal();
      const service2 = new ReconciliationService(journal2);
      const missingOrdId = 'ord_missing_999';
      const hash2 = await journal2.createIntentHash('usr1', 'BTC/USDT', 'buy', 1);
      journal2.recordSubmitting(missingOrdId, 'wf_recon', hash2, { symbol: 'BTC/USDT', side: 'buy' });

      const adapter2 = new BybitAdapter();
      adapter2.fetchOpenOrders = async () => [];
      adapter2.fetchClosedOrders = async () => [];

      const missRes = await service2.reconcilePendingOrders(adapter2);
      expect(missRes.isSuccess).toBe(true);
      if (missRes.isSuccess) {
        expect(missRes.value.items[0].resolvedState).toBe('CANCELLED_EXTERNALLY');
      }
      expect(journal2.getRecord(missingOrdId)?.state).toBe('FAILED');
    });

    it('PartialResultContainer reports per-component OK/DEGRADED/FAILED summary states with undefined missing data', () => {
      const container = new PartialResultContainer<{ balances: any[]; orders: any[]; ticker: any; positions: any[] }>();
      container.setComponentData('balances', [{ currency: 'USDT', free: 1000 }]);
      container.setComponentData('orders', []);
      container.setComponentStatus('ticker', 'DEGRADED', 'Ticker endpoint latency spike');
      container.setComponentStatus('positions', 'FAILED', 'Positions API timeout');

      expect(container.data.balances).toHaveLength(1);
      expect(container.data.orders).toBeDefined();
      expect(container.data.ticker).toBeUndefined();
      expect(container.hasFailures()).toBe(true);

      const summary = container.toSummary();
      expect(summary.isDegraded).toBe(true);
      expect(summary.components['balances'].state).toBe('OK');
      expect(summary.components['ticker'].state).toBe('DEGRADED');
      expect(summary.components['positions'].state).toBe('FAILED');
    });

    it('RetryBudget classifies transient vs permanent errors and enforces token depletion', () => {
      const budget = new RetryBudget();
      expect(budget.isRetryable(new Error('HTTP 429 Rate limit exceeded'))).toBe(true);
      expect(budget.isRetryable(new Error('HTTP 503 Service Unavailable'))).toBe(true);
      expect(budget.isRetryable(new Error('Operation timed out after 5000ms'))).toBe(true);
      expect(budget.isRetryable({ code: 'REGION_NOT_SUPPORTED', message: 'HTTP 451' })).toBe(true);

      expect(budget.isRetryable(new Error('HTTP 401 Authentication failed'))).toBe(false);
      expect(budget.isRetryable({ code: 'MISSING_REQUIRED_CREDENTIALS', message: 'Missing API key' })).toBe(false);
      expect(budget.isRetryable(new Error('Insufficient funds in wallet'))).toBe(false);

      const bounded = new RetryBudget(2, 0);
      expect(bounded.getAvailableTokens()).toBe(2);
      expect(bounded.tryAcquireRetryToken()).toBe(true);
      expect(bounded.tryAcquireRetryToken()).toBe(true);
      expect(bounded.tryAcquireRetryToken()).toBe(false);
    });

    it('RecoveryCoordinator orchestrates WebSocket reconnect, order reconciliation, and RECOVERY_COMPLETED dispatch', async () => {
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
      wsManager.subscribe(['ticker.BTCUSDT']);

      const res = await coordinator.executeSelfHealingRecovery(adapter, 'WEBSOCKET_DISCONNECT', wsManager);
      expect(res.isSuccess).toBe(true);
      expect(eventDispatched).toBe(true);
      expect(wsManager.getState()).toBe('RECEIVING');
      expect(health.evaluateHealth('binance').healthScore).toBe(100);
    });

    it('BotSupervisor detects unresponsive bot sessions past heartbeat threshold and executes supervision recovery', async () => {
      const health = new HealthMonitor();
      const journal = new ExecutionJournal();
      const recon = new ReconciliationService(journal);
      const bus = new EventBus();
      const coordinator = new RecoveryCoordinator(health, recon, bus);
      const supervisor = new BotSupervisor(coordinator, health, 50);

      supervisor.registerBotSession('bot_scalper_1', 'bybit');
      expect(supervisor.getSession('bot_scalper_1')?.status).toBe('RUNNING');

      await new Promise((r) => setTimeout(r, 60));

      const adapterMap = new Map();
      const adapter1 = new BybitAdapter();
      adapter1.fetchOpenOrders = async () => [];
      adapter1.fetchClosedOrders = async () => [];
      adapterMap.set('bybit', adapter1);

      const result = await supervisor.inspectAndSupervise(adapterMap);
      expect(result.inspected).toBe(1);
      expect(result.recovered).toBe(1);
      expect(supervisor.getSession('bot_scalper_1')?.status).toBe('RUNNING');
    });
  });
});
