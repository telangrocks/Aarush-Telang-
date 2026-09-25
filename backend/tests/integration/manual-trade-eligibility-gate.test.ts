import { describe, it, expect, vi, beforeEach } from 'vitest';
import BigNumber from 'bignumber.js';
import { handleTriggerManualTradeAlert } from '../../src/handlers/exchange';
import { ExchangeManager } from '../../src/exchanges';
import { ExecutionEligibilityGate } from '../../src/engine/scanner/ExecutionEligibilityGate';

describe('Manual Trade Pre-Alert Execution Eligibility Gate', () => {
  let capturedAlert: any = null;
  let registerAlertCallCount = 0;

  function createMockContext(requestBody: any) {
    return {
      get: vi.fn().mockReturnValue({ sub: 'user_manual_gate_123' }),
      req: {
        json: vi.fn().mockResolvedValue(requestBody),
      },
      status: vi.fn(),
      json: vi.fn().mockImplementation((data: any) => data),
      env: {
        ENCRYPTION_KEY: 'test_key',
        DB: {
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnValue({
              first: vi.fn().mockResolvedValue({
                exchange_name: 'bybit',
                exchange_environment: 'demo',
                exchange_region: 'global',
                exchange_api_key: 'test_api_key',
              }),
            }),
          }),
        },
        TRADING_BOTS: {
          idFromName: vi.fn().mockReturnValue('bot_id_manual_123'),
          get: vi.fn().mockReturnValue({
            fetch: vi.fn().mockImplementation(async (req: Request) => {
              registerAlertCallCount++;
              const body = await req.json();
              capturedAlert = body.alert;
              return new Response(
                JSON.stringify({ success: true, alertId: capturedAlert.id }),
                { status: 200 }
              );
            }),
          }),
        },
      },
    } as any;
  }

  beforeEach(() => {
    capturedAlert = null;
    registerAlertCallCount = 0;
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Test 1: Ineligible Ticker (BTC @ 5 USDT) — Actual Bybit Constraints
  // =========================================================================
  it('Test 1: Ineligible BTC/USDT with 5 USDT capital is rejected before alert registration', async () => {
    // Authoritative Bybit market rules for BTC/USDT Linear Perpetual:
    // price = ~76950, minOrderQty = 0.001, qtyStep = 0.001, minNotional = 5.0
    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
      fetchTicker: vi.fn().mockResolvedValue({ last: 76950.60 }),
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 } }),
      fetchKlines: vi.fn().mockResolvedValue([]),
      fetchMarkets: vi.fn().mockResolvedValue([
        {
          id: 'BTCUSDT',
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          precision: { price: 0.1, amount: 0.001 },
          limits: {
            price: { min: new BigNumber(0.1) },
            amount: { min: new BigNumber(0.001) },
            cost: { min: new BigNumber(5) },
          },
        },
      ]),
    } as any);

    const mockCtx = createMockContext({
      symbol: 'BTC/USDT',
      strategy: 'ScalperV2',
      config: {
        tradeValueUsdt: 5.0,
        entryPrice: 76950.60,
      },
    });

    const response = await handleTriggerManualTradeAlert(mockCtx);

    // 1. HTTP 400 Bad Request
    expect(mockCtx.status).toHaveBeenCalledWith(400);

    // 2. Clear Rejection Response
    expect(response.success).toBe(false);
    expect(response.code).toBe('EXECUTION_INELIGIBLE');
    expect(response.error).toContain('Quantized qty (0) < minOrderQty (0.001)');
    expect(response.error).toContain('requires min ~$76.95 USDT');

    // 3. PROOF OF ALERT NON-CREATION: /register-alert was NEVER called
    expect(registerAlertCallCount).toBe(0);
    expect(capturedAlert).toBeNull();
  });

  // =========================================================================
  // Test 2: Executable Ticker (XRP/USDT @ 10 USDT) — Actual Bybit Constraints
  // =========================================================================
  it('Test 2: Executable XRP/USDT with 10 USDT creates TradeAlert and proceeds through execution pipeline', async () => {
    // Authoritative Bybit market rules for XRP/USDT:
    // price = 1.35, minOrderQty = 0.1, qtyStep = 0.1, minNotional = 5.0
    // 10 / 1.35 = 7.407 -> quantized to 7.4 XRP -> 7.4 * 1.35 = 9.99 USDT >= 5.0
    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
      fetchTicker: vi.fn().mockResolvedValue({ last: 1.35 }),
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 } }),
      fetchKlines: vi.fn().mockResolvedValue([]),
      fetchMarkets: vi.fn().mockResolvedValue([
        {
          id: 'XRPUSDT',
          symbol: 'XRP/USDT',
          base: 'XRP',
          quote: 'USDT',
          precision: { price: 0.0001, amount: 0.1 },
          limits: {
            price: { min: new BigNumber(0.0001) },
            amount: { min: new BigNumber(0.1) },
            cost: { min: new BigNumber(5) },
          },
        },
      ]),
    } as any);

    const mockCtx = createMockContext({
      symbol: 'XRP/USDT',
      strategy: 'ScalperV2',
      config: {
        tradeValueUsdt: 10.0,
        entryPrice: 1.35,
      },
    });

    const response = await handleTriggerManualTradeAlert(mockCtx);

    // 1. Success returns the alert object
    expect(response.id).toBeDefined();
    expect(response.symbol).toBe('XRP/USDT');

    // 2. Alert registered into Durable Object
    expect(registerAlertCallCount).toBe(1);
    expect(capturedAlert).not.toBeNull();
    expect(capturedAlert.symbol).toBe('XRP/USDT');
    expect(capturedAlert.positionSize).toBe(10.0);
  });

  // =========================================================================
  // Test 3: Symbol Lineage Preservation
  // =========================================================================
  it('Test 3: Ticker from Technical Analysis screen is strictly preserved and never substituted', async () => {
    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
      fetchTicker: vi.fn().mockResolvedValue({ last: 76950.0 }),
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 } }),
      fetchKlines: vi.fn().mockResolvedValue([]),
      fetchMarkets: vi.fn().mockResolvedValue([
        {
          id: 'BTCUSDT',
          symbol: 'BTC/USDT',
          base: 'BTC',
          quote: 'USDT',
          precision: { price: 0.1, amount: 0.001 },
          limits: {
            price: { min: new BigNumber(0.1) },
            amount: { min: new BigNumber(0.001) },
            cost: { min: new BigNumber(5) },
          },
        },
      ]),
    } as any);

    // Sizing 100 USDT makes BTC executable (0.001 BTC = $76.95 >= $5)
    const mockCtx = createMockContext({
      symbol: 'BTC/USDT',
      strategy: 'ScalperV2',
      config: {
        tradeValueUsdt: 100.0,
        entryPrice: 76950.0,
      },
    });

    await handleTriggerManualTradeAlert(mockCtx);

    expect(capturedAlert).not.toBeNull();
    expect(capturedAlert.symbol).toBe('BTC/USDT');
  });

  // =========================================================================
  // Test 4: Missing Exchange Metadata (Fail Closed)
  // =========================================================================
  it('Test 4: Rejects and halts without alert registration if exchange metadata is unavailable', async () => {
    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
      fetchTicker: vi.fn().mockResolvedValue({ last: 50.0 }),
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 } }),
      fetchKlines: vi.fn().mockResolvedValue([]),
      fetchMarkets: vi.fn().mockResolvedValue([]), // Empty markets!
    } as any);

    const mockCtx = createMockContext({
      symbol: 'UNKNOWN/USDT',
      strategy: 'ScalperV2',
      config: {
        tradeValueUsdt: 5.0,
      },
    });

    const response = await handleTriggerManualTradeAlert(mockCtx);

    expect(mockCtx.status).toHaveBeenCalledWith(400);
    expect(response.success).toBe(false);
    expect(response.code).toBe('EXCHANGE_METADATA_UNAVAILABLE');
    expect(registerAlertCallCount).toBe(0);
    expect(capturedAlert).toBeNull();
  });

  // =========================================================================
  // Test 5: Missing or Zero Order Quantity Rules (Fail Closed)
  // =========================================================================
  it('Test 5: Rejects and halts without alert registration if precision or minQty rules are zero', async () => {
    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
      fetchTicker: vi.fn().mockResolvedValue({ last: 50.0 }),
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 } }),
      fetchKlines: vi.fn().mockResolvedValue([]),
      fetchMarkets: vi.fn().mockResolvedValue([
        {
          id: 'CORRUPTEDUSDT',
          symbol: 'CORRUPTED/USDT',
          precision: { price: 0.1, amount: 0 }, // 0 amount precision!
          limits: {
            amount: { min: new BigNumber(0) }, // 0 min qty!
            cost: { min: new BigNumber(5) },
          },
        },
      ]),
    } as any);

    const mockCtx = createMockContext({
      symbol: 'CORRUPTED/USDT',
      strategy: 'ScalperV2',
      config: {
        tradeValueUsdt: 5.0,
      },
    });

    const response = await handleTriggerManualTradeAlert(mockCtx);

    expect(mockCtx.status).toHaveBeenCalledWith(400);
    expect(response.success).toBe(false);
    expect(response.code).toBe('INVALID_EXCHANGE_RULES');
    expect(registerAlertCallCount).toBe(0);
    expect(capturedAlert).toBeNull();
  });

  // =========================================================================
  // Test 6: Post-Rounding Notional Shortfall Edge Case
  // =========================================================================
  it('Test 6: Rejects when quantizedQty satisfies minOrderQty but postRoundingNotional drops below minNotional', async () => {
    // SOL/USDT at $140, 5 USDT / 140 = 0.0357...
    // qtyStep = 0.01, minOrderQty = 0.01, minNotional = 5.0
    // steps = floor(0.0357 / 0.01) = 3 -> quantizedQty = 0.03
    // postRoundingNotional = 0.03 * 140 = 4.20 USDT < 5.0 USDT minNotional!
    vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
      fetchTicker: vi.fn().mockResolvedValue({ last: 140.0 }),
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 } }),
      fetchKlines: vi.fn().mockResolvedValue([]),
      fetchMarkets: vi.fn().mockResolvedValue([
        {
          id: 'SOLUSDT',
          symbol: 'SOL/USDT',
          base: 'SOL',
          quote: 'USDT',
          precision: { price: 0.01, amount: 0.01 },
          limits: {
            price: { min: new BigNumber(0.01) },
            amount: { min: new BigNumber(0.01) },
            cost: { min: new BigNumber(5) },
          },
        },
      ]),
    } as any);

    const mockCtx = createMockContext({
      symbol: 'SOL/USDT',
      strategy: 'ScalperV2',
      config: {
        tradeValueUsdt: 5.0,
        entryPrice: 140.0,
      },
    });

    const response = await handleTriggerManualTradeAlert(mockCtx);

    expect(mockCtx.status).toHaveBeenCalledWith(400);
    expect(response.success).toBe(false);
    expect(response.code).toBe('EXECUTION_INELIGIBLE');
    expect(response.error).toContain('Post-rounding notional ($4.20 USDT) < minNotional ($5.00 USDT)');
    expect(registerAlertCallCount).toBe(0);
    expect(capturedAlert).toBeNull();
  });
});
