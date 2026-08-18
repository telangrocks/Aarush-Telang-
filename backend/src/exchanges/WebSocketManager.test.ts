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
      exchange: 'bybit',
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
      exchange: 'bybit',
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
      exchange: 'bybit',
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

});
