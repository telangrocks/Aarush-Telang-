import { describe, it, expect } from 'vitest';
import { WebSocketManager, EventDeduplicator, ExchangeEvent } from './WebSocketManager';

describe('WebSocketManager & EventDeduplicator', () => {
  it('should correctly deduplicate duplicate events', () => {
    const dedup = new EventDeduplicator();
    const event: ExchangeEvent = {
      eventId: 'evt_1',
      clientOrderId: 'cli_1',
      exchangeOrderId: 'ex_1',
      symbol: 'BTC',
      exchange: 'binance',
      side: 'BUY',
      status: 'filled',
      price: 65000,
      quantity: 1,
      filledQuantity: 1,
      averageFillPrice: 65000,
      eventTime: 1000,
    };

    expect(dedup.isDuplicateOrOutofOrder(event)).toBe(false);
    expect(dedup.isDuplicateOrOutofOrder(event)).toBe(true); // Duplicate dropped
  });

  it('should reject out-of-order delayed packets', () => {
    const dedup = new EventDeduplicator();
    const event1: ExchangeEvent = {
      eventId: 'evt_1',
      clientOrderId: 'cli_1',
      exchangeOrderId: 'ex_1',
      symbol: 'BTC',
      exchange: 'binance',
      side: 'BUY',
      status: 'open',
      price: 65000,
      quantity: 1,
      filledQuantity: 0,
      averageFillPrice: 0,
      eventTime: 2000,
    };

    const delayedEvent: ExchangeEvent = {
      eventId: 'evt_0',
      clientOrderId: 'cli_1',
      exchangeOrderId: 'ex_1',
      symbol: 'BTC',
      exchange: 'binance',
      side: 'BUY',
      status: 'pending',
      price: 65000,
      quantity: 1,
      filledQuantity: 0,
      averageFillPrice: 0,
      eventTime: 1000, // Older timestamp
    };

    expect(dedup.isDuplicateOrOutofOrder(event1)).toBe(false);
    expect(dedup.isDuplicateOrOutofOrder(delayedEvent)).toBe(true); // Out-of-order rejected
  });

  it('should normalize Binance executionReport correctly', () => {
    const mgr = new WebSocketManager();
    const rawReport = {
      e: 'executionReport',
      E: 1499404633056,
      s: 'ETHUSDT',
      c: 'my_client_id',
      S: 'BUY',
      o: 'LIMIT',
      f: 'GTC',
      q: '1.00000000',
      p: '0.10264400',
      X: 'FILLED',
      i: 4293153,
      z: '1.00000000',
      Z: '0.10264400',
      T: 1499404633056,
    };

    const normalized = mgr.normalizeBinanceExecutionReport(rawReport);
    expect(normalized).not.toBeNull();
    expect(normalized?.symbol).toBe('ETH');
    expect(normalized?.exchange).toBe('binance');
    expect(normalized?.status).toBe('filled');
    expect(normalized?.exchangeOrderId).toBe('4293153');
    expect(normalized?.clientOrderId).toBe('my_client_id');
  });

  it('should normalize Bybit order event correctly', () => {
    const mgr = new WebSocketManager();
    const rawReport = {
      topic: 'order',
      data: [
        {
          symbol: 'SOLUSDT',
          orderId: 'bybit_ord_123',
          orderLinkId: 'cli_bybit_1',
          side: 'Buy',
          orderStatus: 'Filled',
          price: '77.5',
          qty: '1',
          cumExecQty: '1',
          avgPrice: '77.5',
          updatedTime: '1690000000000',
        }
      ]
    };

    const normalized = mgr.normalizeBybitOrderEvent(rawReport);
    expect(normalized).not.toBeNull();
    expect(normalized?.symbol).toBe('SOL');
    expect(normalized?.exchange).toBe('bybit');
    expect(normalized?.status).toBe('filled');
    expect(normalized?.exchangeOrderId).toBe('bybit_ord_123');
  });
});
