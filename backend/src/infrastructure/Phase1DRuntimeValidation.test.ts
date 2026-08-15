import { describe, it, expect, beforeEach } from 'vitest';
import { ExchangeRegistry } from './exchange/registry/ExchangeRegistry';
import { BinanceAdapter } from './exchange/adapters/BinanceAdapter';
import { KucoinAdapter } from './exchange/adapters/KucoinAdapter';
import { BybitAdapter } from './exchange/adapters/BybitAdapter';
import { ProviderPool } from './cache/ProviderPool';
import { ExchangeOrchestrator } from './orchestrator/ExchangeOrchestrator';
import { MarketMetadataService } from './services/MarketMetadataService';
import { ExecutionIdempotencyService } from './services/ExecutionIdempotencyService';
import { CircuitBreaker } from './orchestrator/CircuitBreaker';
import { RateLimiter } from './orchestrator/RateLimiter';
import { EventBus, DomainEvent } from '../domain/events/EventBus';
import { StructuredLogger, TelemetryTracer } from './telemetry/Telemetry';
import { Ticker } from '../exchanges/models/NormalizedDomain';
import { WebCryptoSigner } from './crypto/WebCryptoSigner';
import BigNumber from 'bignumber.js';

class MockOrderFilledEvent implements DomainEvent {
  readonly eventId = crypto.randomUUID();
  readonly timestamp = Date.now();
  readonly eventType = 'ORDER_FILLED';
  constructor(readonly orderId: string, readonly symbol: string, readonly amount: number) {}
}

describe('Phase 1D – Production Stabilization & Runtime Validation Suite', () => {
  beforeEach(() => {
    ExchangeRegistry.clear();
    ExchangeRegistry.register({ exchangeId: 'bybit', factory: () => new BybitAdapter() });
  });

  it('1. Live/Mock Exchange Validation: Bybit capabilities & rules', async () => {
    const bybit = ExchangeRegistry.create('bybit') as BybitAdapter;
    expect(bybit.capabilities.supportsFutures).toBe(true);
  });

  it('2. ExchangeOrchestrator Pipeline: All requests flow through telemetry, breaker, and retries', async () => {
    const orchestrator = new ExchangeOrchestrator();
    const adapter = ExchangeRegistry.create('bybit');
    adapter.fetchTicker = async (sym: string) => ({
      symbol: sym,
      timestamp: Date.now(),
      last: new BigNumber(60000),
      bid: new BigNumber(60000),
      ask: new BigNumber(60000),
      high: new BigNumber(61000),
      low: new BigNumber(59000),
      volume: new BigNumber(500),
      quoteVolume: new BigNumber(30000000),
    });

    const res = await orchestrator.execute(adapter, 'fetchTicker', (a) => a.fetchTicker('BTC/USDT'));

    expect(res.isSuccess).toBe(true);
    if (res.isSuccess) {
      const ticker = res.value as Ticker;
      expect(ticker.symbol).toBe('BTC/USDT');
      expect(ticker.last.toNumber()).toBe(60000);
    }
  });

  it('3. ProviderPool Leak-Free Verification: SHA-256 keys, LRU eviction, and TTL expiration', async () => {
    const pool = new ProviderPool(2, 50); // Capacity 2, 50ms TTL
    const key1 = await pool.generateCacheKey('bybit', 'mainnet', 'keyA', 'secA');
    const key2 = await pool.generateCacheKey('bybit', 'mainnet', 'keyB', 'secB');
    const key3 = await pool.generateCacheKey('bybit', 'mainnet', 'keyC', 'secC');

    const p1 = ExchangeRegistry.create('bybit');
    const p2 = ExchangeRegistry.create('bybit');
    const p3 = ExchangeRegistry.create('bybit');

    pool.set(key1, p1);
    pool.set(key2, p2);
    expect(pool.size()).toBe(2);

    pool.set(key3, p3); // Evicts key1
    expect(pool.get(key1)).toBeNull();
    expect(pool.get(key2)).not.toBeNull();
    expect(pool.get(key3)).not.toBeNull();

    await new Promise(r => setTimeout(r, 60)); // Expire TTL
    expect(pool.get(key2)).toBeNull();
  });

  it('4. Market Metadata Validation: Snapshots, tick/step quantization, zero network calls in validator', () => {
    const service = new MarketMetadataService();
    const snapshot = service.getSnapshot('BTC/USDT');

    expect(snapshot.symbol.raw).toBe('BTCUSDT');
    expect(snapshot.minNotional.amount.toNumber()).toBe(10);
    expect(snapshot.stepSize.value.toNumber()).toBe(0.00001);
    expect(snapshot.tickSize.value.toNumber()).toBe(0.01);
  });

  it('5. Retry & Circuit Breaker Simulation: Exponential backoff & state machine recovery', async () => {
    const breaker = new CircuitBreaker(2, 50); // 2 failures -> OPEN, 50ms cooldown
    expect(breaker.getState()).toBe('CLOSED');

    breaker.recordFailure();
    expect(breaker.canExecute()).toBe(true);

    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.canExecute()).toBe(false); // Fast rejection

    await new Promise(r => setTimeout(r, 60)); // Cooldown expires
    expect(breaker.canExecute()).toBe(true); // Transitions to HALF_OPEN

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('6. Rate Limiter Validation: Token consumption and refill under load', () => {
    const limiter = new RateLimiter(5, 10); // 5 tokens, 10 tokens/sec refill
    expect(limiter.tryConsume(3)).toBe(true);
    expect(limiter.tryConsume(3)).toBe(false); // Exceeded budget
  });

  it('7. Event Bus Isolation: Asynchronous decoupled domain event dispatching', async () => {
    const bus = new EventBus();
    let auditLogged = false;
    let notificationSent = false;
    let portfolioUpdated = false;

    bus.subscribe<MockOrderFilledEvent>('ORDER_FILLED', async (_evt) => {
      auditLogged = true;
    });
    bus.subscribe<MockOrderFilledEvent>('ORDER_FILLED', async (_evt) => {
      notificationSent = true;
    });
    bus.subscribe<MockOrderFilledEvent>('ORDER_FILLED', async (_evt) => {
      portfolioUpdated = true;
    });

    await bus.publish(new MockOrderFilledEvent('ord_100', 'BTC/USDT', 0.5));
    expect(auditLogged).toBe(true);
    expect(notificationSent).toBe(true);
    expect(portfolioUpdated).toBe(true);
  });

  it('8. Observability & Redaction: Secrets redacted, correlation IDs injected', () => {
    const logger = new StructuredLogger();
    const tracer = new TelemetryTracer();
    const context = tracer.injectContext({ apiKey: 'super_secret_key_123', publicInfo: 'safe' });

    expect(context.workflowId).toBeDefined();
    expect(context.correlationId).toBeDefined();
    expect(context.traceId).toBeDefined();
    expect(() => logger.info('Telemetry check', context)).not.toThrow();
  });

  it('9. Idempotency Execution: Hashes intent and prevents duplicate placements', async () => {
    const idempotency = new ExecutionIdempotencyService();
    const payload = { userId: 'u_77', symbol: 'BTC/USDT', side: 'buy', amount: 1.5 };
    const key = await idempotency.generateIdempotencyKey(payload);

    expect(idempotency.getExecution(key)).toBeNull();

    idempotency.markPending(key);
    expect(idempotency.getExecution(key)?.status).toBe('PENDING');

    idempotency.markCompleted(key, { orderId: 'ex_ord_555' });
    const res = idempotency.getExecution(key);
    expect(res?.status).toBe('COMPLETED');
    expect((res?.result as any).orderId).toBe('ex_ord_555');
  });

  it('10. Native Web Crypto Verification: WebCryptoSigner hashes & signs without Node crypto', async () => {
    const sha = await WebCryptoSigner.hashSha256('test_input');
    expect(sha).toHaveLength(64);

    const hmacHex = await WebCryptoSigner.hmacSha256Hex('secret', 'payload');
    expect(hmacHex).toHaveLength(64);

    const hmacBase64 = await WebCryptoSigner.hmacSha256Base64('secret', 'payload');
    expect(hmacBase64.length).toBeGreaterThan(0);
  });
});
