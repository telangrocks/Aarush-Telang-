import { describe, it, expect } from 'vitest';
import { ResilientWebSocketManager } from './WebSocketManager';
import { MockExchangeSocketAdapter } from './adapters/ExchangeSocketAdapter';

describe('Milestone 4 — WebSocketManager & Recovery Unit Tests', () => {
  it('ResilientWebSocketManager manages lifecycle states cleanly', () => {
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

  it('ResilientWebSocketManager detects lost heartbeats and executes reconnection flow', async () => {
    const adapter = new MockExchangeSocketAdapter();
    const manager = new ResilientWebSocketManager(adapter, 20); // 20ms heartbeat timeout

    manager.subscribe(['ticker.ETHUSDT']);
    manager.simulateConnect();

    await new Promise(r => setTimeout(r, 40));
    expect(manager.checkHeartbeat()).toBe(false);
    expect(manager.getState()).toBe('HEARTBEAT_LOST');

    manager.simulateReconnectAndResubscribe();
    expect(manager.getState()).toBe('RECEIVING');
    expect(manager.getSubscriptions()).toContain('ticker.ETHUSDT');
  });
});
