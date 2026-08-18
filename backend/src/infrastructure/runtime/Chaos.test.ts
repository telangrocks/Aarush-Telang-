import { describe, it, expect } from 'vitest';
import { HealthMonitor } from './HealthMonitor';
import { ExecutionJournal } from './ExecutionJournal';
import { ReconciliationService } from './ReconciliationService';
import { PartialResultContainer } from './PartialFailureFramework';
import { BybitAdapter } from '../exchange/adapters/BybitAdapter';
import { ResilientWebSocketManager } from './WebSocketManager';
import { MockExchangeSocketAdapter } from './adapters/ExchangeSocketAdapter';
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
});
