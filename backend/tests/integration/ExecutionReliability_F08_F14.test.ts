import { describe, it, expect, vi, beforeEach } from 'vitest';
import BigNumber from 'bignumber.js';
import { BybitAdapter } from '../../src/infrastructure/exchange/adapters/BybitAdapter';
import { handleAcknowledgeAlert, handleGetTicker } from '../../src/handlers/exchange';
import { ExchangeManager } from '../../src/exchanges/ExchangeManager';
import { ReconciliationEngine } from '../../src/engine/reconciliation/ReconciliationEngine';
import { TradingBot } from '../../src/trading-bot';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('test_decrypted_secret'),
}));

vi.mock('../../src/handlers/notifications', () => ({
  sendTradeNotification: vi.fn().mockResolvedValue({ success: true }),
  sendTradeFillNotification: vi.fn().mockResolvedValue({ success: true }),
}));

describe('CryptoPulse Refurbishment F-08 through F-14 Verification', () => {

  describe('F-09 & F-12: BybitAdapter Linear V5 Order Parameters & Clock Calibration', () => {
    let adapter: BybitAdapter;

    beforeEach(() => {
      adapter = new BybitAdapter({
        apiKey: 'test-key',
        secret: 'test-secret',
        environment: 'demo',
      });
    });

    it('F-09: Market orders omit timeInForce to prevent retCode 10001 rejection', async () => {
      let capturedBody: any = null;
      vi.spyOn(adapter as any, 'makeRequest').mockImplementation(async (method: string, path: string, params: any) => {
        if (path === '/v5/order/create') {
          capturedBody = params;
          return { orderId: 'test-order-1' };
        }
        if (path === '/v5/position/list') {
          return { list: [{ positionIdx: 0 }] };
        }
        return {};
      });

      await adapter.createOrder({
        symbol: 'SOXL/USDT',
        side: 'buy',
        type: 'market',
        amount: new BigNumber('0.16'),
        clientOrderId: 'ec2281c5-53c6-475c-b29d-4728777254cf',
        category: 'linear',
        timeInForce: 'IOC',
        params: { tickSize: 0.01, stepSize: 0.01 },
      } as any);

      expect(capturedBody).toBeDefined();
      expect(capturedBody.orderType).toBe('Market');
      expect(capturedBody.timeInForce).toBeUndefined(); // Strictly omitted for Market orders in Bybit V5 even if IOC passed
      expect(capturedBody.positionIdx).toBe(0);
      expect(capturedBody.qty).toBe('0.16');
      expect(capturedBody.symbol).toBe('SOXLUSDT');
    });

    it('F-09: Limit orders include timeInForce: GTC', async () => {
      let capturedBody: any = null;
      vi.spyOn(adapter as any, 'makeRequest').mockImplementation(async (method: string, path: string, params: any) => {
        if (path === '/v5/order/create') {
          capturedBody = params;
          return { orderId: 'test-order-limit' };
        }
        return {};
      });

      await adapter.createOrder({
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'limit',
        amount: new BigNumber('0.002'),
        price: new BigNumber('62000.50'),
        clientOrderId: 'order-limit-1',
        category: 'linear',
        positionIdx: 0,
        params: { tickSize: 0.1, stepSize: 0.001, positionIdx: 0 },
      } as any);

      expect(capturedBody).toBeDefined();
      expect(capturedBody.orderType).toBe('Limit');
      expect(capturedBody.timeInForce).toBe('GTC');
      expect(capturedBody.price).toBe('62000.5');
    });

    it('F-09: Linear TP/SL prices are quantized to tickSize decimal precision', async () => {
      let capturedBody: any = null;
      vi.spyOn(adapter as any, 'makeRequest').mockImplementation(async (method: string, path: string, params: any) => {
        if (path === '/v5/order/create') {
          capturedBody = params;
          return { orderId: 'test-order-tpsl' };
        }
        return {};
      });

      await adapter.createOrder({
        symbol: 'SOXL/USDT',
        side: 'buy',
        type: 'market',
        amount: new BigNumber('0.16'),
        clientOrderId: 'order-tpsl-1',
        category: 'linear',
        positionIdx: 0,
        takeProfit: 65.2567,
        stopLoss: 58.9123,
        params: { tickSize: 0.01, stepSize: 0.01, positionIdx: 0 },
      } as any);

      expect(capturedBody).toBeDefined();
      // TickSize 0.01 has 2 decimals; BUY TP ceils to 65.26, BUY SL floors to 58.91
      expect(capturedBody.takeProfit).toBe('65.26');
      expect(capturedBody.stopLoss).toBe('58.91');
    });

    it('F-09: Resolves Hedge Mode positionIdx dynamically if account uses Hedge Mode', async () => {
      let capturedBody: any = null;
      vi.spyOn(adapter as any, 'makeRequest').mockImplementation(async (method: string, path: string, params: any) => {
        if (path === '/v5/order/create') {
          capturedBody = params;
          return { orderId: 'test-order-hedge' };
        }
        return {};
      });

      await adapter.createOrder({
        symbol: 'ETH/USDT',
        side: 'buy',
        type: 'market',
        amount: new BigNumber('1.0'),
        clientOrderId: 'order-hedge-1',
        category: 'linear',
        positionIdx: 1,
      } as any);

      expect(capturedBody).toBeDefined();
      expect(capturedBody.positionIdx).toBe(1); // Long side in Hedge Mode
    });

    it('F-12: Auto-recovers on timestamp drift error (retCode 10002) and retries with calibrated time', async () => {
      await adapter.connect({
        apiKey: 'test-key',
        secret: 'test-secret',
        environment: 'demo',
      });
      let attempts = 0;
      vi.spyOn(adapter as any, 'fetchServerTimeOffset').mockImplementation(async () => 1500);
      vi.spyOn(adapter as any, 'fetchWithTimeout').mockImplementation(async (url: string) => {
        attempts++;
        if (attempts === 1) {
          // Bybit returns HTTP 200 with retCode 10002
          return new Response(JSON.stringify({
            retCode: 10002,
            retMsg: 'Req_time is not in recv_window'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          retCode: 0,
          retMsg: 'OK',
          result: { list: [] }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const res = await (adapter as any).makeRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, true);
      expect(res).toBeDefined();
      expect(attempts).toBe(2); // Initial failed call + auto-calibrated retry
    });

    it('F-12: retCode 10003 (Invalid API key) does NOT trigger clock calibration and throws UnifiedError', async () => {
      await adapter.connect({
        apiKey: 'test-invalid-key',
        secret: 'test-secret',
        environment: 'demo',
      });
      const calledUrls: string[] = [];
      const fetchTimeSpy = vi.spyOn(adapter as any, 'fetchServerTimeOffset');
      vi.spyOn(adapter as any, 'fetchWithTimeout').mockImplementation(async (url: string) => {
        calledUrls.push(url);
        if (url.includes('/v5/market/time')) {
          return new Response(JSON.stringify({ retCode: 0, timeNano: '1700000000000000000' }), { status: 200 });
        }
        return new Response(JSON.stringify({
          retCode: 10003,
          retMsg: 'apiKey is invalid'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      await expect(
        (adapter as any).makeRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, true)
      ).rejects.toThrow();

      // Ensure /v5/account/wallet-balance was called strictly once and never auto-retried on 10003
      const balanceCalls = calledUrls.filter(u => u.includes('/v5/account/wallet-balance'));
      expect(balanceCalls.length).toBe(1);
    });
  });

  describe('F-08: WAL Idempotency & Safe Retry Attempt Lifecycle in TradingBot', () => {
    let mockStorage: Map<string, any>;
    let mockState: any;
    let mockEnv: any;
    let bot: TradingBot;

    beforeEach(() => {
      mockStorage = new Map<string, any>();
      mockState = {
        id: { toString: () => 'mock-trading-bot-f08' },
        storage: {
          get: async (k: string) => mockStorage.get(k),
          put: async (k: string | Record<string, any>, v?: any) => {
            if (typeof k === 'string') mockStorage.set(k, v);
            else for (const [entryKey, entryVal] of Object.entries(k)) mockStorage.set(entryKey, entryVal);
          },
          delete: async (k: string) => mockStorage.delete(k),
          transaction: async (cb: any) => cb({
            get: async (k: string) => mockStorage.get(k),
            put: async (k: string, v: any) => mockStorage.set(k, v),
            delete: async (k: string) => mockStorage.delete(k),
            list: async () => mockStorage,
          }),
          list: async () => mockStorage,
          setAlarm: vi.fn(),
          deleteAlarm: vi.fn(),
        },
        blockConcurrencyWhile: async (fn: any) => fn(),
        waitUntil: vi.fn(),
      };

      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            exchange_name: 'bybit',
            exchange_environment: 'demo',
            exchange_api_key_encrypted: 'key',
            exchange_api_secret_encrypted: 'sec',
          }),
          all: vi.fn().mockResolvedValue({
            results: [{ name: 'target_entry_price' }, { name: 'entry_status' }]
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      };

      mockEnv = {
        DB: mockDb,
        ENVIRONMENT: 'test',
        ENCRYPTION_KEY: 'test-encryption-key-32-chars-long!',
      };

      bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId: 'user-f08-test',
        budgetUsdt: 10,
        approvedSymbols: ['SOXL', 'SOXLUSDT', 'SOXL/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'demo',
        accountFingerprint: 'bybit:demo',
        orderType: 'ALL',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        symbolMetadataSnapshot: {}
      });
      (bot as any).runtimeState = {
        isInitialized: true,
        isActive: true,
        userId: 'user-f08-test',
        coinId: 'SOXL/USDT',
        strategy: 'scalper-v2',
        monitoredSymbols: ['SOXL/USDT'],
        activePositions: [],
        alerts: [],
        activeIntents: new Map(),
      };

      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({
          last: new BigNumber(62.14),
          symbol: 'SOXL/USDT',
        }),
        fetchMarket: vi.fn().mockResolvedValue({
          id: 'SOXLUSDT',
          symbol: 'SOXL/USDT',
          category: 'linear',
          precision: { amount: 0.01, price: 0.01 },
          limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } },
        }),
        fetchPositions: vi.fn().mockImplementation(async (category?: string, symbol?: string, includeZero?: boolean) => {
          if (symbol && includeZero) {
            return [{ symbol, positionIdx: 0, size: new BigNumber(0) }];
          }
          return [];
        }),
        createOrder: vi.fn().mockResolvedValue({
          id: 'ord-bybit-exec-1',
          status: 'closed',
          filled: new BigNumber(0.16),
          amount: new BigNumber(0.16),
          average: new BigNumber(62.14),
          price: new BigNumber(62.14),
        }),
      } as any);

      vi.spyOn(ExchangeManager, 'executeIdempotentOrder').mockImplementation(async (provider: any, req: any) => {
        return provider.createOrder(req);
      });
    });

    it('F-08: In-flight order intent blocks duplicate dispatch with HTTP 409', async () => {
      const alertId = 'alert-inflight-1';
      const targetAlert = {
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      };
      mockStorage.set('alerts', [targetAlert]);
      mockStorage.set(`intent:order:${alertId}`, {
        intentId: alertId,
        status: 'INTENT_PERSISTED',
        actualExecutedQuantity: 0,
      });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      const json = await response.json<any>();
      expect(response.status).toBe(409);
      expect(json.code).toBe('DUPLICATE_DISPATCH_BLOCKED');
    });

    it('F-08: Completed/filled order returns HTTP 200 idempotent handled', async () => {
      const alertId = 'alert-filled-1';
      const completedAlert = {
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'filled',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      };
      mockStorage.set('alerts', [completedAlert]);
      mockStorage.set(`intent:order:${alertId}`, {
        intentId: alertId,
        status: 'FILLED',
        actualOrderId: 'bybit-ord-999',
        actualExecutedQuantity: 0.16,
      });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      const json = await response.json<any>();
      expect(response.status).toBe(200);
      expect(json.code).toBe('DUPLICATE_DISPATCH_BLOCKED');
      expect(json.message).toBe('Execution already handled.');
    });

    it('F-08: Ambiguous UNKNOWN outcome blocks retry with HTTP 423 RECONCILIATION_REQUIRED', async () => {
      const alertId = 'alert-unknown-1';
      const targetAlert = {
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      };
      mockStorage.set('alerts', [targetAlert]);
      mockStorage.set(`intent:order:${alertId}`, {
        intentId: alertId,
        status: 'UNKNOWN',
        actualExecutedQuantity: 0,
      });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      const json = await response.json<any>();
      expect(response.status).toBe(423);
      expect(json.code).toBe('RECONCILIATION_REQUIRED');
    });

    it('F-08: Missing order in immediate query during delayed visibility window remains locked in RECONCILIATION_PENDING (HTTP 423)', async () => {
      const alertId = 'alert-delayed-vis-1';
      const targetAlert = {
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      };
      mockStorage.set('alerts', [targetAlert]);
      // Attempt recently dispatched (e.g. 30s ago, within 15m RECON_WINDOW_MS)
      mockStorage.set(`intent:order:${alertId}`, {
        intentId: alertId,
        attemptNumber: 1,
        status: 'RECONCILIATION_PENDING',
        dispatchedAt: Date.now() - 30000,
        createdAt: Date.now() - 30000,
        actualExecutedQuantity: 0,
      });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      const json = await response.json<any>();
      // Must remain locked with HTTP 423 RECONCILIATION_REQUIRED
      expect(response.status).toBe(423);
      expect(json.code).toBe('RECONCILIATION_REQUIRED');
      expect(json.message).toContain('Automatic reconciliation is pending');
    });

    it('F-08: Failed order intent (0 fill) authorizes safe retry attempt #2 with attemptHistory', async () => {
      const alertId = 'alert-retry-test-1';
      const targetAlert = {
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'failed',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      };
      mockStorage.set('alerts', [targetAlert]);
      // Attempt 1 failed
      mockStorage.set(`intent:order:${alertId}`, {
        intentId: alertId,
        attemptNumber: 1,
        status: 'FAILED',
        terminalReason: 'EXCHANGE_REJECTED',
        actualExecutedQuantity: 0,
        updatedAt: Date.now() - 5000,
      });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId,
          symbol: 'SOXL/USDT',
          side: 'BUY',
          entryIntent: 'IMMEDIATE',
        }),
      });

      const response = await bot.fetch(req);
      const json = await response.json<any>();
      expect(response.status).toBe(200);
      expect(json.success).toBe(true);

      // Verify that WAL snapshot now contains attempt #2 with attemptHistory
      const finalIntent = mockStorage.get(`intent:order:${alertId}`);
      expect(finalIntent).toBeDefined();
      expect(finalIntent.attemptNumber).toBe(2);
      expect(finalIntent.attemptHistory).toHaveLength(1);
      expect(finalIntent.attemptHistory[0].attemptNumber).toBe(1);
      expect(finalIntent.attemptHistory[0].status).toBe('FAILED');
    });

    it('F-08: Dispatched FAILED intent requires exchange reconciliation; blocks retry with 409 if order exists on exchange', async () => {
      const alertId = 'alert-recon-test-1';
      const targetAlert = {
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'failed',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      };
      mockStorage.set('alerts', [targetAlert]);
      mockStorage.set(`intent:order:${alertId}`, {
        intentId: alertId,
        attemptNumber: 1,
        status: 'FAILED',
        dispatchedAt: Date.now() - 60000,
        actualExecutedQuantity: 0,
      });

      vi.spyOn(ReconciliationEngine, 'reconcile').mockResolvedValueOnce({
        intentId: alertId,
        status: 'FILLED',
        actualOrderId: 'ord-discovered-1',
        actualExecutedQuantity: '0.16',
      } as any);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      const json = await response.json<any>();
      expect(response.status).toBe(409);
      expect(json.code).toBe('DUPLICATE_DISPATCH_BLOCKED');
      expect(json.error).toBe('ORDER_EXISTS_ON_EXCHANGE');
    });

    it('F-08: Dispatched FAILED intent blocks with 423 if exchange reconciliation query fails', async () => {
      const alertId = 'alert-recon-fail-1';
      const targetAlert = {
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'failed',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      };
      mockStorage.set('alerts', [targetAlert]);
      mockStorage.set(`intent:order:${alertId}`, {
        intentId: alertId,
        attemptNumber: 1,
        status: 'FAILED',
        dispatchedAt: Date.now() - 60000,
        actualExecutedQuantity: 0,
      });

      vi.spyOn(ReconciliationEngine, 'reconcile').mockRejectedValueOnce(new Error('Connection timed out to Bybit'));

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      const json = await response.json<any>();
      expect(response.status).toBe(423);
      expect(json.code).toBe('RECONCILIATION_REQUIRED');
    });

    it('F-08: Missing order in immediate query during delayed visibility window remains locked in RECONCILIATION_PENDING (HTTP 423)', async () => {
      const alertId = 'alert-delayed-vis-1';
      const targetAlert = {
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      };
      mockStorage.set('alerts', [targetAlert]);
      // Attempt recently dispatched (e.g. 30s ago, within 15m RECON_WINDOW_MS)
      mockStorage.set(`intent:order:${alertId}`, {
        intentId: alertId,
        attemptNumber: 1,
        status: 'RECONCILIATION_PENDING',
        dispatchedAt: Date.now() - 30000,
        createdAt: Date.now() - 30000,
        actualExecutedQuantity: 0,
      });

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      const json = await response.json<any>();
      // Must remain locked with HTTP 423 RECONCILIATION_REQUIRED
      expect(response.status).toBe(423);
      expect(json.code).toBe('RECONCILIATION_REQUIRED');
      expect(json.message).toContain('Automatic reconciliation is pending');
    });
  });

  describe('F-10: Alert Acknowledgment Canonical Routes', () => {
    it('F-10: handleAcknowledgeAlert accepts alertId from JSON request body', async () => {
      const mockBotFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
      const mockEnv = {
        TRADING_BOTS: {
          idFromName: () => 'bot-1',
          get: () => ({ fetch: mockBotFetch })
        }
      };

      const mockContext = {
        env: mockEnv,
        get: () => ({ sub: 'user-1' }),
        req: {
          param: () => undefined,
          json: async () => ({ alertId: 'alert-body-123' })
        },
        json: (data: any) => data,
        status: vi.fn(),
      } as any;

      const result = await handleAcknowledgeAlert(mockContext);
      expect(result).toEqual({ success: true });
      expect(mockBotFetch).toHaveBeenCalled();
    });

    it('F-10: handleAcknowledgeAlert accepts alertId from path parameter', async () => {
      const mockBotFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
      const mockEnv = {
        TRADING_BOTS: {
          idFromName: () => 'bot-1',
          get: () => ({ fetch: mockBotFetch })
        }
      };

      const mockContext = {
        env: mockEnv,
        get: () => ({ sub: 'user-1' }),
        req: {
          param: (name: string) => name === 'alertId' ? 'alert-path-456' : undefined,
          json: async () => ({})
        },
        json: (data: any) => data,
        status: vi.fn(),
      } as any;

      const result = await handleAcknowledgeAlert(mockContext);
      expect(result).toEqual({ success: true });
      expect(mockBotFetch).toHaveBeenCalled();
    });
  });

  describe('F-11: Resilient Ticker Handler with Fallback', () => {
    it('F-11: Returns HTTP 503 instead of unhandled 500 when exchange ticker fails without cache', async () => {
      const mockUser = {
        exchange_name: 'bybit',
        exchange_environment: 'demo',
        exchange_region: null,
        exchange_api_key_encrypted: 'key',
        exchange_api_secret_encrypted: 'secret',
      };

      const mockDb = {
        prepare: () => ({
          bind: () => ({
            first: async () => mockUser
          })
        })
      };

      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
        fetchTicker: async () => { throw new Error('Bybit network timeout'); }
      } as any);

      let statusCode = 0;
      let responseJson: any = null;
      const mockContext = {
        env: { DB: mockDb },
        get: () => ({ sub: 'user-1' }),
        req: {
          query: (name: string) => name === 'symbol' ? 'UNKNOWN/USDT' : undefined
        },
        status: (code: number) => { statusCode = code; },
        json: (data: any) => { responseJson = data; return data; },
        header: vi.fn(),
      } as any;

      await handleGetTicker(mockContext);
      expect(statusCode).toBe(503);
      expect(responseJson.code).toBe('EXCHANGE_UNAVAILABLE');
    });
  });

  describe('F-08: Gate 1 — Exchange Reconciliation, Execution History & Partial Fill Safety', () => {
    it('blocks retry with HTTP 409 PARTIAL_FILL_LOCK when previous attempt had partial fill even if position is now closed', async () => {
      const mockStorage = new Map<string, any>();
      const alertId = 'alert-partial-closed-1';
      const targetAlert = {
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'failed',
        timestamp: new Date().toISOString(),
        strategy: 'scalper-v2',
        positionSize: 10,
        stopLoss: 58.91,
        takeProfit: 65.26,
      };

      mockStorage.set('alerts', [targetAlert]);
      // Previous intent had actualExecutedQuantity > 0 (partial fill)
      mockStorage.set(`intent:order:${alertId}`, {
        intentId: alertId,
        alertId,
        symbol: 'SOXL/USDT',
        status: 'FAILED',
        actualExecutedQuantity: '0.08', // Partial fill!
        actualOrderId: 'bybit-ord-part-1',
        createdAt: Date.now() - 60000,
        dispatchedAt: Date.now() - 60000,
      });

      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId: 'user-part-test',
        budgetUsdt: 10,
        approvedSymbols: ['SOXL', 'SOXLUSDT', 'SOXL/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'demo',
        accountFingerprint: 'bybit:demo',
        orderType: 'ALL',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        symbolMetadataSnapshot: {}
      });
      const mockState = {
        blockConcurrencyWhile: vi.fn(async (cb: any) => cb()),
        storage: {
          get: vi.fn(async (key: string) => mockStorage.get(key)),
          put: vi.fn(async (key: string, val: any) => mockStorage.set(key, val)),
          list: vi.fn(async () => mockStorage),
          transaction: vi.fn(async (cb: any) => cb({
            get: vi.fn(async (k: string) => mockStorage.get(k)),
            put: vi.fn(async (k: string, v: any) => mockStorage.set(k, v)),
            list: vi.fn(async () => mockStorage),
          })),
        },
      } as any;

      const mockDb = {
        prepare: () => ({
          bind: () => ({
            first: async () => ({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_region: null,
              exchange_api_key_encrypted: 'key',
              exchange_api_secret_encrypted: 'sec',
            }),
            all: async () => ({ results: [] }),
          }),
          all: async () => ({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] }),
          run: async () => ({ success: true }),
        }),
      };

      const testBot = new TradingBot(mockState, { DB: mockDb, ENCRYPTION_KEY: 'test-encryption-key-32-chars-long!' } as any);
      (testBot as any).runtimeState = {
        isInitialized: true,
        isActive: true,
        userId: 'user-part-test',
        coinId: 'SOXL/USDT',
        strategy: 'scalper-v2',
        monitoredSymbols: ['SOXL/USDT'],
        activePositions: [],
        alerts: [targetAlert],
        activeIntents: new Map([[alertId, mockStorage.get(`intent:order:${alertId}`)]]),
      };

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId }),
      });

      const res = await testBot.fetch(req);
      expect(res.status).toBe(409);
      const body = await res.json() as any;
      expect(body.code).toBe('PARTIAL_FILL_LOCK');
      expect(body.message).toContain('previous attempt partially filled');
    });

    it('considers order history, execution history, open orders, and position state together in ReconciliationEngine', async () => {
      const intent: any = {
        intentId: 'cid-recon-multi',
        symbol: 'BTC/USDT',
        status: 'UNKNOWN',
        actualExecutedQuantity: '0',
        actualFillPrice: null,
        reconciliationAttemptCount: 4,
        createdAt: Date.now() - 20 * 60 * 1000, // 20m ago (> RECON_WINDOW_MS)
      };

      const mockAdapter: any = {
        fetchOrder: vi.fn().mockRejectedValue({ code: 'ORDER_NOT_FOUND', httpStatus: 404 }),
        fetchClosedOrders: vi.fn().mockResolvedValue([]),
        fetchPositions: vi.fn().mockImplementation(async (category?: string, symbol?: string, includeZero?: boolean) => {
          if (symbol && includeZero) {
            return [{ symbol, positionIdx: 0, size: new BigNumber(0) }];
          }
          return [];
        }), // Position is flat
        fetchOpenOrders: vi.fn().mockResolvedValue([]), // No open orders
        // BUT execution history has trades for this order!
        fetchMyTrades: vi.fn().mockResolvedValue([
          {
            id: 'exec-1',
            orderId: 'bybit-ord-99',
            orderLinkId: 'cid-recon-multi',
            symbol: 'BTC/USDT',
            side: 'buy',
            price: new BigNumber(60000),
            amount: new BigNumber(0.05),
          }
        ]),
      };

      const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());
      // Must NOT be declared ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION because executions exist
      expect(result.status).toBe('PARTIALLY_FILLED');
      expect(result.actualExecutedQuantity).toBe('0.05');
    });

    it('fails closed and retains lock when any exchange evidence query fails', async () => {
      const intent: any = {
        intentId: 'cid-evidence-fail',
        symbol: 'BTC/USDT',
        status: 'UNKNOWN',
        actualExecutedQuantity: '0',
        actualFillPrice: null,
        reconciliationAttemptCount: 4,
        createdAt: Date.now() - 20 * 60 * 1000,
      };

      const mockAdapter: any = {
        fetchOrder: vi.fn().mockRejectedValue({ code: 'ORDER_NOT_FOUND', httpStatus: 404 }),
        fetchClosedOrders: vi.fn().mockResolvedValue([]),
        fetchPositions: vi.fn().mockRejectedValue(new Error('Bybit 502 Bad Gateway')), // Evidence query throws!
        fetchOpenOrders: vi.fn().mockResolvedValue([]),
        fetchMyTrades: vi.fn().mockResolvedValue([]),
      };

      const result = await ReconciliationEngine.reconcile(mockAdapter, intent, Date.now());
      // Fails closed to UNKNOWN, retaining lock
      expect(result.status).toBe('UNKNOWN');
      expect((result as any).flatnessAffirmativelyVerified).toBeFalsy();
    });
  });

  describe('F-09: Fail-Closed Position Mode Discovery and Validation in TradingBot', () => {
    let bot: TradingBot;
    let mockStorage: Map<string, any>;
    let mockState: any;
    let mockEnv: any;
    let createOrderSpy: any;
    let fetchPositionsMock: any;

    beforeEach(async () => {
      mockStorage = new Map<string, any>();
      mockState = {
        id: { toString: () => 'f09-test-do-id' },
        storage: {
          get: vi.fn().mockImplementation(async (k: string) => mockStorage.get(k)),
          put: vi.fn().mockImplementation(async (k: string, v: any) => mockStorage.set(k, v)),
          delete: vi.fn().mockImplementation(async (k: string) => mockStorage.delete(k)),
          list: vi.fn().mockImplementation(async () => mockStorage),
          setAlarm: vi.fn().mockResolvedValue(undefined),
          transaction: vi.fn().mockImplementation(async (cb: any) => cb({
            get: vi.fn().mockImplementation(async (k: string) => mockStorage.get(k)),
            put: vi.fn().mockImplementation(async (k: string, v: any) => mockStorage.set(k, v)),
            delete: vi.fn().mockImplementation(async (k: string) => mockStorage.delete(k)),
          })),
        },
        blockConcurrencyWhile: vi.fn().mockImplementation(async (cb: any) => cb()),
      };

      mockEnv = {
        DB: {
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_api_key_encrypted: 'key',
              exchange_api_secret_encrypted: 'sec',
            }),
            all: vi.fn().mockResolvedValue({ results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] }),
            run: vi.fn().mockResolvedValue({ success: true }),
          }),
        },
        ENVIRONMENT: 'test',
        ENCRYPTION_KEY: 'test-encryption-key-32-chars-long!',
      };

      bot = new TradingBot(mockState, mockEnv);
      mockStorage.set('approvedCandidateRecord', {
        approvalGeneration: 1,
        userId: 'user-f09-test',
        budgetUsdt: 10,
        approvedSymbols: ['SOXL', 'SOXLUSDT', 'SOXL/USDT'],
        approvalState: 'FINAL_APPROVED',
        exchangeName: 'bybit',
        environment: 'demo',
        accountFingerprint: 'bybit:demo',
        orderType: 'ALL',
        approvedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        symbolMetadataSnapshot: {}
      });
      (bot as any).runtimeState = {
        isInitialized: true,
        isActive: true,
        userId: 'user-f09-test',
        coinId: 'SOXL/USDT',
        strategy: 'scalper-v2',
        monitoredSymbols: ['SOXL/USDT'],
        activePositions: [],
        alerts: [],
        activeIntents: new Map(),
      };

      createOrderSpy = vi.fn().mockImplementation(async (orderReq: any) => ({
        id: 'ord-bybit-f09',
        status: 'closed',
        filled: new BigNumber(orderReq.amount || 0.16),
        amount: new BigNumber(orderReq.amount || 0.16),
        average: new BigNumber(62.14),
        price: new BigNumber(62.14),
      }));

      fetchPositionsMock = vi.fn();

      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({
          last: 62.14,
          bid: 62.13,
          ask: 62.15,
        }),
        fetchMarket: vi.fn().mockResolvedValue({
          id: 'SOXLUSDT',
          symbol: 'SOXL/USDT',
          category: 'linear',
          precision: { amount: 0.01, price: 0.01 },
          limits: { cost: { min: 5 }, amount: { min: 0.01, max: 1000 } },
        }),
        fetchPositions: fetchPositionsMock,
        createOrder: createOrderSpy,
      } as any);

      vi.spyOn(ExchangeManager, 'executeIdempotentOrder').mockImplementation(async (provider: any, req: any) => {
        return provider.createOrder(req);
      });
    });

    it('submits order with positionIdx 0 when account is verified in One-Way mode', async () => {
      fetchPositionsMock.mockResolvedValue([
        { symbol: 'SOXL/USDT', positionIdx: 0, size: new BigNumber(0) },
      ]);

      const alertId = 'alert-f09-oneway';
      mockStorage.set('alerts', [{
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      }]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      expect(response.status).toBe(200);
      expect(createOrderSpy).toHaveBeenCalledTimes(1);
      const passedReq = createOrderSpy.mock.calls[0][0];
      expect(passedReq.positionIdx).toBe(0);
      expect(passedReq.params.positionIdx).toBe(0);
    });

    it('submits BUY order with positionIdx 1 when account is verified in Hedge mode', async () => {
      fetchPositionsMock.mockResolvedValue([
        { symbol: 'SOXL/USDT', positionIdx: 1, size: new BigNumber(0) },
        { symbol: 'SOXL/USDT', positionIdx: 2, size: new BigNumber(0) },
      ]);

      const alertId = 'alert-f09-hedge-buy';
      mockStorage.set('alerts', [{
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      }]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      expect(response.status).toBe(200);
      expect(createOrderSpy).toHaveBeenCalledTimes(1);
      const passedReq = createOrderSpy.mock.calls[0][0];
      expect(passedReq.positionIdx).toBe(1);
      expect(passedReq.params.positionIdx).toBe(1);
    });

    it('submits SELL order with positionIdx 2 when account is verified in Hedge mode', async () => {
      fetchPositionsMock.mockResolvedValue([
        { symbol: 'SOXL/USDT', positionIdx: 1, size: new BigNumber(0) },
        { symbol: 'SOXL/USDT', positionIdx: 2, size: new BigNumber(0) },
      ]);

      const alertId = 'alert-f09-hedge-sell';
      mockStorage.set('alerts', [{
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'SELL',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      }]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'SELL' }),
      });

      const response = await bot.fetch(req);
      expect(response.status).toBe(200);
      expect(createOrderSpy).toHaveBeenCalledTimes(1);
      const passedReq = createOrderSpy.mock.calls[0][0];
      expect(passedReq.positionIdx).toBe(2);
      expect(passedReq.params.positionIdx).toBe(2);
    });

    it('refuses order submission and fails closed when fetchPositions returns empty array []', async () => {
      fetchPositionsMock.mockResolvedValue([]);

      const alertId = 'alert-f09-empty';
      mockStorage.set('alerts', [{
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      }]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      expect(response.status).toBe(422);
      const body = await response.json<any>();
      expect(body.success).toBe(false);
      expect(body.code).toBe('POSITION_MODE_UNVERIFIED');
      expect(body.details.reason).toBe('EMPTY_POSITION_LIST');
      expect(createOrderSpy).not.toHaveBeenCalled();
    });

    it('refuses order submission and fails closed when positionIdx is missing in position records', async () => {
      fetchPositionsMock.mockResolvedValue([
        { symbol: 'SOXL/USDT', size: new BigNumber(0) }, // missing positionIdx
      ]);

      const alertId = 'alert-f09-missing-idx';
      mockStorage.set('alerts', [{
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      }]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      expect(response.status).toBe(422);
      const body = await response.json<any>();
      expect(body.success).toBe(false);
      expect(body.code).toBe('POSITION_MODE_UNVERIFIED');
      expect(body.details.reason).toBe('MALFORMED_POSITION_IDX');
      expect(createOrderSpy).not.toHaveBeenCalled();
    });

    it('refuses order submission and fails closed when position data has malformed positionIdx', async () => {
      fetchPositionsMock.mockResolvedValue([
        { symbol: 'SOXL/USDT', positionIdx: 'hedge_corrupted', size: new BigNumber(0) },
      ]);

      const alertId = 'alert-f09-malformed';
      mockStorage.set('alerts', [{
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      }]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      expect(response.status).toBe(422);
      const body = await response.json<any>();
      expect(body.success).toBe(false);
      expect(body.code).toBe('POSITION_MODE_UNVERIFIED');
      expect(body.details.reason).toBe('MALFORMED_POSITION_IDX');
      expect(createOrderSpy).not.toHaveBeenCalled();
    });

    it('refuses order submission and fails closed when conflicting position modes are detected (both 0 and 1/2)', async () => {
      fetchPositionsMock.mockResolvedValue([
        { symbol: 'SOXL/USDT', positionIdx: 0, size: new BigNumber(0) },
        { symbol: 'SOXL/USDT', positionIdx: 1, size: new BigNumber(0) },
      ]);

      const alertId = 'alert-f09-conflict';
      mockStorage.set('alerts', [{
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      }]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      expect(response.status).toBe(422);
      const body = await response.json<any>();
      expect(body.success).toBe(false);
      expect(body.code).toBe('POSITION_MODE_UNVERIFIED');
      expect(body.details.reason).toBe('CONFLICTING_POSITION_MODE');
      expect(createOrderSpy).not.toHaveBeenCalled();
    });

    it('refuses order submission and fails closed when exchange query throws a network/API failure', async () => {
      fetchPositionsMock.mockRejectedValue(new Error('Bybit 504 Gateway Timeout'));

      const alertId = 'alert-f09-query-fail';
      mockStorage.set('alerts', [{
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      }]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      expect(response.status).toBe(422);
      const body = await response.json<any>();
      expect(body.success).toBe(false);
      expect(body.code).toBe('POSITION_MODE_UNVERIFIED');
      expect(body.details.reason).toBe('EXCHANGE_QUERY_FAILED');
      expect(body.details.underlying).toContain('504');
      expect(createOrderSpy).not.toHaveBeenCalled();
    });

    it('proves that pre-reservation WAL intent is safely marked FAILED and never locked when mode is unverified', async () => {
      fetchPositionsMock.mockResolvedValue([]);

      const alertId = 'alert-f09-wal-cleanup';
      mockStorage.set('alerts', [{
        id: alertId,
        symbol: 'SOXL/USDT',
        side: 'BUY',
        status: 'pending',
        entryPrice: 62.14,
        positionSize: 10,
        quantity: 0.16,
        strategy: 'scalper-v2',
      }]);

      const req = new Request('http://bot/execute-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, symbol: 'SOXL/USDT', side: 'BUY' }),
      });

      const response = await bot.fetch(req);
      expect(response.status).toBe(422);
      expect(createOrderSpy).not.toHaveBeenCalled();

      // Verify WAL intent state
      const intent = mockStorage.get(`intent:order:${alertId}`);
      expect(intent).toBeDefined();
      expect(intent.status).toBe('FAILED');
      expect(intent.terminalReason).toContain('Empty position metadata');
    });
  });
});
