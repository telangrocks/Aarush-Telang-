import { describe, it, expect } from 'vitest';
import { ExecutionIdempotencyService } from '../services/ExecutionIdempotencyService';
import { EventBus, DomainEvent } from '../../domain/events/EventBus';
import { ExchangeRepository, UserExchangeCredentials } from './Repositories';

class TestOrderEvent implements DomainEvent {
  readonly eventId = 'evt_123';
  readonly timestamp = Date.now();
  readonly eventType = 'TEST_ORDER';
  constructor(readonly symbol: string) {}
}

describe('Idempotency, Repositories, and EventBus Unit Tests', () => {
  it('ExecutionIdempotencyService hashes payload and prevents duplicate executions', async () => {
    const service = new ExecutionIdempotencyService();
    const payload = { userId: 'u1', symbol: 'BTC/USDT', side: 'buy', amount: 1 };
    const key = await service.generateIdempotencyKey(payload);

    expect(service.getExecution(key)).toBeNull();

    service.markPending(key);
    expect(service.getExecution(key)?.status).toBe('PENDING');

    service.markCompleted(key, { orderId: 'ord_999' });
    const completed = service.getExecution(key);
    expect(completed?.status).toBe('COMPLETED');
    expect((completed?.result as any).orderId).toBe('ord_999');
  });

  it('EventBus publishes domain events to registered handlers', async () => {
    const bus = new EventBus();
    let handledSymbol = '';

    bus.subscribe<TestOrderEvent>('TEST_ORDER', (evt) => {
      handledSymbol = evt.symbol;
    });

    await bus.publish(new TestOrderEvent('ETH/USDT'));
    expect(handledSymbol).toBe('ETH/USDT');
  });

  it('ExchangeRepository operates safely with mock database bindings', async () => {
    let queryRun = false;
    const mockDb = {
      prepare: () => ({
        bind: () => ({
          run: async () => { queryRun = true; },
          first: async () => null,
        }),
      }),
    };

    const repo = new ExchangeRepository(mockDb);
    const creds: UserExchangeCredentials = {
      userId: 'usr_1',
      exchangeName: 'binance',
      environment: 'mainnet',
      apiKey: 'k123',
      encryptedSecret: 'sec_enc',
      secretIv: 'iv_123',
    };

    await repo.saveUserCredentials(creds);
    expect(queryRun).toBe(true);
  });
});
