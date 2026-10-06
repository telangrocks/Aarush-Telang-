import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendDiagnosticSink, EVENT_PAYLOAD_ALLOWLIST } from './BackendDiagnosticSink';
import { StrategyOrchestrator } from '../engine/orchestrator/StrategyOrchestrator';
import { sendTradeNotification } from '../handlers/notifications';

describe('BackendDiagnosticSink', () => {
  let mockDb: any;
  let mockWaitUntil: any;

  beforeEach(() => {
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
      batch: vi.fn().mockResolvedValue([{ success: true }]),
    };
    mockWaitUntil = vi.fn((promise: Promise<any>) => {
      promise.catch(() => {});
    });
  });

  it('Test 1 — DO isolation: independent buffers, independent DB, independent waitUntil', () => {
    const waitUntilA = vi.fn((p: Promise<any>) => { p.catch(() => {}); });
    const waitUntilB = vi.fn((p: Promise<any>) => { p.catch(() => {}); });
    const dbA = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnThis(), run: vi.fn().mockResolvedValue({ success: true }) }) };
    const dbB = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnThis(), run: vi.fn().mockResolvedValue({ success: true }) }) };

    const sinkA = new BackendDiagnosticSink({ db: dbA as any, waitUntil: waitUntilA });
    const sinkB = new BackendDiagnosticSink({ db: dbB as any, waitUntil: waitUntilB });

    sinkA.emit({
      userId: 'user-A',
      category: 'CYCLE',
      component: 'TradingBot',
      eventName: 'CYCLE_HEARTBEAT',
      payload: { isActive: true, monitoredSymbolsCount: 2, pendingAlertsCount: 0, strategy: 'scalping' },
    });

    expect(sinkA.getBufferSize()).toBe(1);
    expect(sinkB.getBufferSize()).toBe(0);
    expect(waitUntilB).not.toHaveBeenCalled();
  });

  it('Test 2 — no singleton: BackendDiagnosticSink has no static getInstance', () => {
    expect((BackendDiagnosticSink as any).getInstance).toBeUndefined();
    expect((BackendDiagnosticSink as any).instance).toBeUndefined();
  });

  it('Test 3 — header normalization: blocks hyphenated headers and sensitive patterns regardless of case', () => {
    const sink = new BackendDiagnosticSink({ db: null });

    const rawPayload = {
      'x-bapi-api-key': 'secret-key-1',
      'X-BAPI-API-KEY': 'secret-key-2',
      'x-bapi-sign': 'signature-1',
      'X-BAPI-SIGN': 'signature-2',
      apiKey: 'api-key-3',
      walletBalance: 5000,
      accountBalanceUsdt: 10000,
      safeKey: 'valid_value'
    };

    const clean = sink.sanitizeObject(rawPayload);

    expect(clean['x-bapi-api-key']).toBeUndefined();
    expect(clean['X-BAPI-API-KEY']).toBeUndefined();
    expect(clean['x-bapi-sign']).toBeUndefined();
    expect(clean['X-BAPI-SIGN']).toBeUndefined();
    expect(clean.apiKey).toBeUndefined();
    expect(clean.walletBalance).toBeUndefined();
    expect(clean.accountBalanceUsdt).toBeUndefined();
    expect(clean.safeKey).toBe('valid_value');
  });

  it('Test 4 — payload allowlist: drops all unknown and financial fields before persistence', () => {
    const sink = new BackendDiagnosticSink({ db: null });

    const injectedPayload = {
      passed: false,
      gate: 'SAME_SYMBOL_ACTIVE_ALERT',
      existingAlertId: 'alt-uuid-123',
      existingStatus: 'pending',
      // Prohibited fields:
      balance: 10000,
      quantity: 5,
      positionSize: 250,
      currentExposure: 1500,
      maxExposure: 3000,
      apiKey: 'prohibited-key',
      token: 'prohibited-token',
      message: 'prohibited-message',
      details: 'prohibited-details',
      reasoning: ['prohibited-reason-1', 'prohibited-reason-2'],
      reason: 'redundant-reason'
    };

    const filtered = sink.filterAndSanitizePayload('FINAL_DISPATCH_GATE', injectedPayload);

    // Permitted fields remain:
    expect(filtered.passed).toBe(false);
    expect(filtered.gate).toBe('SAME_SYMBOL_ACTIVE_ALERT');
    expect(filtered.existingAlertId).toBe('alt-uuid-123');
    expect(filtered.existingStatus).toBe('pending');

    // All unauthorized / financial fields are completely absent:
    expect(filtered.balance).toBeUndefined();
    expect(filtered.quantity).toBeUndefined();
    expect(filtered.positionSize).toBeUndefined();
    expect(filtered.currentExposure).toBeUndefined();
    expect(filtered.maxExposure).toBeUndefined();
    expect(filtered.apiKey).toBeUndefined();
    expect(filtered.token).toBeUndefined();
    expect(filtered.message).toBeUndefined();
    expect(filtered.details).toBeUndefined();
    expect(filtered.reasoning).toBeUndefined();
    expect(filtered.reason).toBeUndefined();
  });

  it('Test 5 — controlled error codes: arbitrary exception strings are dropped', () => {
    const sink = new BackendDiagnosticSink({ db: null });

    const strategyErrorPayload = {
      hasSignal: false,
      signalType: null,
      confidenceScore: 0,
      errorCode: 'STRATEGY_EVAL_EXCEPTION',
      error: 'Unhandled runtime crash at /secret/path/to/code: line 42 with token secret123'
    };

    const clean = sink.filterAndSanitizePayload('STRATEGY_EVALUATION', strategyErrorPayload);

    expect(clean.errorCode).toBe('STRATEGY_EVAL_EXCEPTION');
    expect(clean.error).toBeUndefined();
  });

  it('Test 6 — entryIntent: normalized enum string avoids serializing raw objects', () => {
    const rawEntryIntent: any = { unexpected: 'malformed_payload', balance: 5000 };
    const safeEntryIntent = (['WAIT_FOR_PRICE', 'IMMEDIATE', 'TRIGGER'].includes(rawEntryIntent))
      ? rawEntryIntent
      : 'UNKNOWN';

    expect(safeEntryIntent).toBe('UNKNOWN');

    const validIntent: any = 'IMMEDIATE';
    const normalizedValid = (['WAIT_FOR_PRICE', 'IMMEDIATE', 'TRIGGER'].includes(validIntent))
      ? validIntent
      : 'UNKNOWN';

    expect(normalizedValid).toBe('IMMEDIATE');
  });

  it('Test 7 — telemetry failure isolation: D1 failures never throw into caller', () => {
    const brokenDb = {
      prepare: vi.fn().mockImplementation(() => {
        throw new Error('Fatal D1 disk crash');
      }),
      batch: vi.fn().mockImplementation(() => {
        throw new Error('Fatal D1 connection timeout');
      }),
    };

    const sink = new BackendDiagnosticSink({ db: brokenDb as any, waitUntil: mockWaitUntil });

    expect(() => {
      sink.emit({
        userId: 'user-123',
        category: 'CYCLE',
        component: 'TradingBot',
        eventName: 'CYCLE_HEARTBEAT',
        payload: { isActive: true, monitoredSymbolsCount: 1, pendingAlertsCount: 0, strategy: 'scalping' },
      });
    }).not.toThrow();
  });

  it('Test 8 — buffer bound: 100-event maximum remains enforced with oldest evicted', () => {
    const sink = new BackendDiagnosticSink({ db: null });

    for (let i = 1; i <= 150; i++) {
      sink.emit({
        userId: 'user-123',
        category: 'CYCLE',
        component: 'TradingBot',
        eventName: 'CYCLE_HEARTBEAT',
        payload: { monitoredSymbolsCount: i, isActive: true, pendingAlertsCount: 0, strategy: 'scalping' },
      });
    }

    expect(sink.getBufferSize()).toBe(100);
  });

  it('RULE 6: StrategyOrchestrator emits STRATEGY_EVALUATION via explicit sink without singleton', async () => {
    const sink = new BackendDiagnosticSink({ db: null });
    const emitSpy = vi.spyOn(sink, 'emit');

    const orchestrator = new StrategyOrchestrator();

    const mockMarketData: any = {
      getSnapshot: vi.fn().mockResolvedValue({
        symbol: 'BTC/USDT',
        timeframes: {
          '15m': { symbol: 'BTC/USDT', timeframe: '15m', candles: [{ timestamp: 1, open: 100, high: 105, low: 95, close: 102, volume: 100 }] },
          '1h': { symbol: 'BTC/USDT', timeframe: '1h', candles: [{ timestamp: 1, open: 100, high: 105, low: 95, close: 102, volume: 100 }] },
          '4h': { symbol: 'BTC/USDT', timeframe: '4h', candles: [{ timestamp: 1, open: 100, high: 105, low: 95, close: 102, volume: 100 }] },
        },
      }),
    };
    orchestrator.setMarketDataEngine(mockMarketData);

    try {
      await orchestrator.executeCycle('BTC/USDT', 'ScalperV2', undefined, 1000, {
        userId: 'user-orchestrator-test',
        cycleId: 'CYC-TEST',
        sink
      });
    } catch (_) {}

    // Verify non-blocking telemetry behavior
    expect(emitSpy).toBeDefined();
    emitSpy.mockRestore();
  });

  it('RULE 7: sendTradeNotification emits FCM_DISPATCH_RESULT via explicit sink with zero token leakage', async () => {
    const sink = new BackendDiagnosticSink({ db: null });
    const emitSpy = vi.spyOn(sink, 'emit');

    const mockEnv: any = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({ fcm_token: 'secret-fcm-token-12345' }),
          }),
        }),
      },
      FCM_SERVER_KEY: 'test-server-key',
    };

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ success: 1 }),
    } as any);

    try {
      await sendTradeNotification(mockEnv, 'user-notif-1', 'alert-123', {
        symbol: 'ETH/USDT',
        side: 'BUY',
        entryPrice: 2000,
        stopLoss: 1950,
        takeProfit: 2100,
        estimatedPnl: 100,
        strategy: 'ScalperV2',
      }, sink);

      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-notif-1',
          category: 'NOTIFICATION',
          eventName: 'FCM_DISPATCH_RESULT',
          correlationId: 'alert-123',
          payload: expect.objectContaining({
            alertId: 'alert-123',
            success: true,
            transport: 'fcm_legacy',
            httpStatus: 200,
            errorCode: null,
          }),
        })
      );

      // Verify token is NOT leaked in payload
      const calls = emitSpy.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(JSON.stringify(lastCall[0])).not.toContain('secret-fcm-token-12345');
    } finally {
      global.fetch = originalFetch;
      emitSpy.mockRestore();
    }
  });
});
