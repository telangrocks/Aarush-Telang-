import { describe, it, expect } from 'vitest';
import { ExchangeOrchestrator } from './ExchangeOrchestrator';
import { BybitAdapter } from '../exchange/adapters/BybitAdapter';
import { ValidationPipeline } from '../safety/ValidationPipeline';
import { ValidationContext } from '../safety/ValidationContext';

describe('Milestone 10 — ExchangeOrchestrator Pipeline Integration Unit Tests', () => {
  it('ExchangeOrchestrator executes validated order pipeline cleanly', async () => {
    const orchestrator = new ExchangeOrchestrator();
    const adapter = new BybitAdapter();
    const pipeline = new ValidationPipeline(true);

    const context = new ValidationContext({
      intent: {
        userId: 'usr_1',
        exchangeId: 'binance',
        environment: 'mainnet',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 50000,
        quantity: 0.1,
      },
      marketRules: {
        symbol: 'BTC/USDT',
        tickSize: 0.1,
        stepSize: 0.001,
        minNotional: 10,
      },
      accountBalanceUsdt: 10000,
    });

    const res = await orchestrator.validateAndExecuteOrder(
      pipeline,
      context,
      adapter,
      'createOrder',
      async (_ad) => ({ orderId: 'ex_123' })
    );

    expect(res.isSuccess).toBe(true);
    if (res.isSuccess) {
      expect(res.value).toEqual({ orderId: 'ex_123' });
    }
  });

  it('ExchangeOrchestrator rejects order when ValidationPipeline fails before exchange dispatch', async () => {
    const orchestrator = new ExchangeOrchestrator();
    const adapter = new BybitAdapter();
    const pipeline = new ValidationPipeline(true);

    const invalidContext = new ValidationContext({
      intent: {
        userId: 'usr_1',
        exchangeId: 'binance',
        environment: 'mainnet',
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        price: 0, // Invalid limit price
      },
    });

    let exchangeCalled = false;
    const res = await orchestrator.validateAndExecuteOrder(
      pipeline,
      invalidContext,
      adapter,
      'createOrder',
      async () => {
        exchangeCalled = true;
        return { orderId: 'ex_never' };
      }
    );

    expect(res.isFailure).toBe(true);
    expect(exchangeCalled).toBe(false); // Exchange adapter NEVER invoked!
  });
});
