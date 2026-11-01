import { describe, it, expect, vi, beforeEach } from "vitest";
import { TradingBot } from "../../src/trading-bot";
import BigNumber from "bignumber.js";

// Mock security crypto
vi.mock("../../src/crypto", () => ({
  decrypt: vi.fn().mockResolvedValue("mocked_secret_key"),
}));

// Mock notifications
vi.mock("../../src/handlers/notifications", () => ({
  sendTradeNotification: vi.fn().mockResolvedValue({ success: true }),
  sendTradeFillNotification: vi.fn().mockResolvedValue({ success: true }),
}));

let mockAdapterInstance: any;

// Mock exchanges adapter
vi.mock("../../src/exchanges", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    ExchangeManager: {
      getProvider: vi.fn().mockImplementation(() => Promise.resolve(mockAdapterInstance)),
    },
    normalizeEnvironment: vi.fn().mockReturnValue('demo'),
    resolveCanonicalRoutingRegion: vi.fn().mockReturnValue('global'),
  };
});

describe("Position-Lifecycle Safety Suite - Invariants & Recovery", () => {
  let mockStorage: Map<string, any>;
  let mockState: any;
  let mockEnv: any;
  let d1Positions: Map<string, any>;
  let d1AuditLog: Map<string, any>;
  let scheduledAlarmTime: number | null;
  let alarmDeleted: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = new Map();
    d1Positions = new Map();
    d1AuditLog = new Map();
    scheduledAlarmTime = null;
    alarmDeleted = false;

    mockAdapterInstance = {
      fetchPositions: vi.fn().mockResolvedValue([]),
      fetchClosedPnl: vi.fn().mockResolvedValue([]),
      fetchTicker: vi.fn().mockImplementation(async (sym: string) => ({
        symbol: sym.replace('/', ''),
        last: 50000,
        bid: 49990,
        ask: 50010,
        high: 51000,
        low: 49000,
        volume: 1000,
        quoteVolume: 50000000,
      })),
      fetchKlines: vi.fn().mockResolvedValue([]),
      fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 10000 }, total: { USDT: 10000 } }),
      fetchMarkets: vi.fn().mockResolvedValue([]),
      fetchMarket: vi.fn().mockResolvedValue(null),
    };

    mockState = {
      id: { toString: () => "mock-do-id" },
      storage: {
        get: async (keyOrKeys: string | string[]) => {
          if (Array.isArray(keyOrKeys)) {
            const res = new Map();
            for (const k of keyOrKeys) {
              if (mockStorage.has(k)) res.set(k, mockStorage.get(k));
            }
            return res;
          }
          return mockStorage.get(keyOrKeys);
        },
        put: async (keyOrEntries: string | Record<string, any>, val?: any) => {
          if (typeof keyOrEntries === 'string') {
            mockStorage.set(keyOrEntries, val);
          } else if (keyOrEntries && typeof keyOrEntries === 'object') {
            for (const [k, v] of Object.entries(keyOrEntries)) {
              mockStorage.set(k, v);
            }
          }
        },
        delete: async (key: string) => mockStorage.delete(key),
        transaction: async (cb: any) => cb({
          get: async (keyOrKeys: string | string[]) => {
            if (Array.isArray(keyOrKeys)) {
              const res = new Map();
              for (const k of keyOrKeys) {
                if (mockStorage.has(k)) res.set(k, mockStorage.get(k));
              }
              return res;
            }
            return mockStorage.get(keyOrKeys);
          },
          put: async (keyOrEntries: string | Record<string, any>, val?: any) => {
            if (typeof keyOrEntries === 'string') {
              mockStorage.set(keyOrEntries, val);
            } else if (keyOrEntries && typeof keyOrEntries === 'object') {
              for (const [k, v] of Object.entries(keyOrEntries)) {
                mockStorage.set(k, v);
              }
            }
          },
          delete: async (key: string) => mockStorage.delete(key),
        }),
        setAlarm: vi.fn().mockImplementation(async (time: number) => {
          scheduledAlarmTime = time;
          alarmDeleted = false;
        }),
        deleteAlarm: vi.fn().mockImplementation(async () => {
          alarmDeleted = true;
          scheduledAlarmTime = null;
        }),
        list: async (opts?: any) => {
          if (opts?.prefix) {
            const m = new Map();
            for (const [k, v] of mockStorage.entries()) {
              if (k.startsWith(opts.prefix)) m.set(k, v);
            }
            return m;
          }
          return mockStorage;
        },
      },
      blockConcurrencyWhile: async (cb: any) => cb(),
    };

    const mockDb = {
      batch: vi.fn().mockImplementation(async (stmts: any[]) => {
        const results = [];
        for (const s of stmts) {
          if (s && typeof s.run === 'function') {
            const r = await s.run();
            results.push(r);
          } else {
            results.push({ success: true, meta: { changes: 1 } });
          }
        }
        return results;
      }),
      prepare: vi.fn().mockImplementation((query: string) => ({
        bind: vi.fn().mockImplementation((...args: any[]) => ({
          run: vi.fn().mockImplementation(async () => {
            if (query.includes('DELETE FROM trade_positions')) {
              const id = args[0];
              const existed = d1Positions.has(id);
              d1Positions.delete(id);
              return { success: true, meta: { changes: existed ? 1 : 0 } };
            }
            if (query.includes('INSERT INTO audit_log')) {
              const id = args[0];
              const userId = args[1];
              const isConflict = query.includes('AUDIT_CONFLICT_DETECTED');
              const action = isConflict ? 'AUDIT_CONFLICT_DETECTED' : 'POSITION_CLOSED';
              const metadataStr = args[2];
              const createdAt = args[3];

              // Native SQLite UPSERT simulation
              const existing = d1AuditLog.get(id);
              if (existing && !isConflict) {
                let existingMeta: any = null;
                try { existingMeta = JSON.parse(existing.metadata); } catch (_) {}
                let incomingMeta: any = null;
                try { incomingMeta = JSON.parse(metadataStr); } catch (_) {}

                // ON CONFLICT DO UPDATE WHERE json_valid=0 OR existing=HISTORICAL and incoming=VERIFIED
                const canUpgrade = (!existingMeta || existingMeta.evidenceStatus === 'HISTORICAL_DATA_UNAVAILABLE') &&
                                   (incomingMeta && incomingMeta.evidenceStatus === 'VERIFIED_EXCHANGE_RECORD');

                if (canUpgrade) {
                  d1AuditLog.set(id, { id, user_id: userId, action, metadata: metadataStr, created_at: createdAt });
                }
                // If canUpgrade is false (e.g. existing is already VERIFIED, or incoming is not VERIFIED), preserve existing
              } else {
                d1AuditLog.set(id, { id, user_id: userId, action, metadata: metadataStr, created_at: createdAt });
              }
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 1 } };
          }),
          first: vi.fn().mockImplementation(async () => {
            if (query.includes('FROM users')) {
              return {
                exchange_name: 'bybit',
                exchange_environment: 'demo',
                exchange_region: 'global',
                exchange_api_key: 'mock_key',
                exchange_api_secret_encrypted: 'mock_sec',
                exchange_api_secret_iv: 'mock_iv',
                exchange_api_secret_salt: 'mock_salt',
              };
            }
            if (query.includes('FROM trade_positions')) {
              const id = args[0];
              return d1Positions.get(id) || null;
            }
            if (query.includes('FROM audit_log')) {
              const id = args[0];
              return d1AuditLog.get(id) || null;
            }
            if (query.includes('PRAGMA table_info')) {
              return { name: 'target_entry_price' };
            }
            return null;
          }),
          all: vi.fn().mockImplementation(async () => {
            if (query.includes('FROM trade_positions')) {
              return { results: Array.from(d1Positions.values()) };
            }
            if (query.includes('PRAGMA table_info')) {
              return { results: [{ name: 'target_entry_price' }, { name: 'entry_status' }] };
            }
            return { results: [] };
          }),
        })),
      })),
    };

    mockEnv = {
      DB: mockDb,
      ENCRYPTION_KEY: "mock_key_0123456789012345678901",
      COOKIE_ENCRYPTION_KEY: "mock_key_0123456789012345678901",
      GLOBAL_TRADING_HALT: "false",
    };
  });

  // --------------------------------------------------------------------------
  // Test 1: Deactivation with active exposure schedules 60s alarm
  // --------------------------------------------------------------------------
  it("Test 1: Deactivation with active exposure schedules 60s alarm", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-1";
    mockStorage.set("userId", userId);
    mockStorage.set("isActive", true);
    mockStorage.set("activePositions", [
      {
        id: "pos-active-1",
        symbol: "BTC/USDT",
        side: "BUY",
        size: 0.1,
      }
    ]);

    const req = new Request("http://bot/deactivate", { method: "POST" });
    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    const body: any = await res.json();
    expect(body.status).toBe("deactivated");
    expect(body.activeExposureRemaining).toBe(true);
    expect(body.safetyAlarmScheduled).toBe(true);

    // Verify 60s safety alarm was scheduled
    expect(mockState.storage.setAlarm).toHaveBeenCalled();
    expect(scheduledAlarmTime).toBeGreaterThan(Date.now() + 50000);
    expect(scheduledAlarmTime).toBeLessThanOrEqual(Date.now() + 61000);
    expect(mockStorage.get("isActive")).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 2: Alarm self-terminates when account is verified flat
  // --------------------------------------------------------------------------
  it("Test 2: Alarm self-terminates when account is verified flat", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-2";
    mockStorage.set("userId", userId);
    mockStorage.set("isActive", false);
    mockStorage.set("activePositions", []); // No DO positions
    // d1Positions is empty
    mockAdapterInstance.fetchPositions.mockResolvedValue([]); // Bybit flat

    await bot.alarm();

    // Verify deleteAlarm was called because account is confirmed flat
    expect(mockState.storage.deleteAlarm).toHaveBeenCalled();
    expect(alarmDeleted).toBe(true);
    expect(scheduledAlarmTime).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Test 3: DO restart discovers D1 position and reconciles against Bybit
  // --------------------------------------------------------------------------
  it("Test 3: DO restart discovers D1 position and reconciles against Bybit", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-3";
    const posId = "pos-restart-1";
    mockStorage.set("userId", userId);
    mockStorage.set("isActive", true);
    mockStorage.set("activePositions", []); // DO memory empty after restart

    const entryTime = 1787467000000;
    d1Positions.set(posId, {
      id: posId,
      user_id: userId,
      symbol: "BTC/USDT",
      side: "BUY",
      entry_price: 50000,
      quantity: 0.1,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo",
      created_at: new Date(entryTime).toISOString(),
    });

    // Bybit reports 0 exposure (closed on exchange)
    mockAdapterInstance.fetchPositions.mockResolvedValue([]);
    // Bybit closed PnL provides authoritative closure record
    mockAdapterInstance.fetchClosedPnl.mockResolvedValue([
      {
        symbol: "BTC/USDT",
        orderId: "ord-close-3",
        side: "sell",
        qty: 0.1,
        closedPnl: 150,
        avgEntryPrice: 50000,
        avgExitPrice: 51500,
        updatedTime: entryTime + 100000,
      }
    ]);

    await bot.alarm();

    // Position should be reconciled and deleted from D1
    expect(d1Positions.has(posId)).toBe(false);
    // Verified audit record must be written
    expect(d1AuditLog.has(`pos_close_${posId}`)).toBe(true);
    const auditRecord = d1AuditLog.get(`pos_close_${posId}`);
    const meta = JSON.parse(auditRecord.metadata);
    expect(meta.evidenceStatus).toBe("VERIFIED_EXCHANGE_RECORD");
    expect(meta.realizedPnl).toBe(150);
  });

  // --------------------------------------------------------------------------
  // Test 4: Consolidated multi-fill closure aggregates PnL and fills array
  // --------------------------------------------------------------------------
  it("Test 4: Consolidated multi-fill closure aggregates PnL and fills array", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-4";
    const posId = "pos-multi-1";
    mockStorage.set("userId", userId);
    mockStorage.set("activePositions", []);

    const entryTime = 1787467000000;
    d1Positions.set(posId, {
      id: posId,
      user_id: userId,
      symbol: "ETH/USDT",
      side: "BUY",
      entry_price: 3000,
      quantity: 2.0,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo",
      created_at: new Date(entryTime).toISOString(),
    });

    mockAdapterInstance.fetchPositions.mockResolvedValue([]);
    // Two partial fills closing the 2.0 ETH position
    mockAdapterInstance.fetchClosedPnl.mockResolvedValue([
      {
        symbol: "ETH/USDT",
        orderId: "fill-ord-1",
        side: "sell",
        closedSize: 1.0,
        closedPnl: 50,
        avgEntryPrice: 3000,
        avgExitPrice: 3050,
        updatedTime: entryTime + 5000,
      },
      {
        symbol: "ETH/USDT",
        orderId: "fill-ord-2",
        side: "sell",
        closedSize: 1.0,
        closedPnl: 70,
        avgEntryPrice: 3000,
        avgExitPrice: 3070,
        updatedTime: entryTime + 8000,
      }
    ]);

    const req = new Request(`http://bot/execution-status?positionId=${posId}`, { method: "GET" });
    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    expect(d1Positions.has(posId)).toBe(false);
    expect(d1AuditLog.has(`pos_close_${posId}`)).toBe(true);

    const audit = d1AuditLog.get(`pos_close_${posId}`);
    const meta = JSON.parse(audit.metadata);
    expect(meta.evidenceStatus).toBe("VERIFIED_EXCHANGE_RECORD");
    expect(meta.realizedPnl).toBe(120); // 50 + 70
    expect(meta.closePrice).toBe(3060); // (3050*1 + 3070*1) / 2
    expect(meta.closedQty).toBe(2.0);
    expect(meta.fills).toHaveLength(2);
    expect(meta.fills[0].orderId).toBe("fill-ord-1");
    expect(meta.fills[1].orderId).toBe("fill-ord-2");
  });

  // --------------------------------------------------------------------------
  // Test 5: Flat fallback records HISTORICAL_DATA_UNAVAILABLE with null PnL
  // --------------------------------------------------------------------------
  it("Test 5: Flat fallback records HISTORICAL_DATA_UNAVAILABLE with null PnL", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-5";
    const posId = "pos-flat-1";
    mockStorage.set("userId", userId);
    mockStorage.set("activePositions", []);

    d1Positions.set(posId, {
      id: posId,
      user_id: userId,
      symbol: "SOL/USDT",
      side: "BUY",
      entry_price: 150,
      quantity: 5.0,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo",
      created_at: new Date(1787467000000).toISOString(),
    });

    mockAdapterInstance.fetchPositions.mockResolvedValue([]);
    // Closed PnL history unavailable
    mockAdapterInstance.fetchClosedPnl.mockResolvedValue([]);

    const req = new Request(`http://bot/execution-status?positionId=${posId}`, { method: "GET" });
    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    expect(d1Positions.has(posId)).toBe(false);
    expect(d1AuditLog.has(`pos_close_${posId}`)).toBe(true);

    const audit = d1AuditLog.get(`pos_close_${posId}`);
    const meta = JSON.parse(audit.metadata);
    expect(meta.evidenceStatus).toBe("HISTORICAL_DATA_UNAVAILABLE");
    expect(meta.realizedPnl).toBeNull();
    expect(meta.closePrice).toBeNull();
    expect(meta.closeReason).toBe("exchange_position_flat");
  });

  // --------------------------------------------------------------------------
  // Test 6: Audit pre-check fast path skips external Bybit calls
  // --------------------------------------------------------------------------
  it("Test 6: Audit pre-check fast path skips external Bybit calls", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-6";
    const posId = "pos-fastpath-1";
    mockStorage.set("userId", userId);
    mockStorage.set("activePositions", []);

    // Existing verified audit record already stored in D1
    d1AuditLog.set(`pos_close_${posId}`, {
      id: `pos_close_${posId}`,
      user_id: userId,
      action: "POSITION_CLOSED",
      metadata: JSON.stringify({
        positionId: posId,
        symbol: "BTC/USDT",
        evidenceStatus: "VERIFIED_EXCHANGE_RECORD",
        realizedPnl: 200,
        closePrice: 52000,
        closedQty: 0.1,
      }),
      created_at: new Date().toISOString(),
    });

    d1Positions.set(posId, {
      id: posId,
      user_id: userId,
      symbol: "BTC/USDT",
      side: "BUY",
      entry_price: 50000,
      quantity: 0.1,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo",
    });

    mockAdapterInstance.fetchPositions.mockResolvedValue([]);

    const req = new Request(`http://bot/execution-status?positionId=${posId}`, { method: "GET" });
    await bot.fetch(req);

    // fetchClosedPnl should NOT be called because verified record is already present
    expect(mockAdapterInstance.fetchClosedPnl).not.toHaveBeenCalled();
    expect(d1Positions.has(posId)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 7: Upgrade idempotency allows verified upgrade and rejects downgrade
  // --------------------------------------------------------------------------
  it("Test 7: Upgrade idempotency allows verified upgrade and rejects downgrade", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-7";
    const posId = "pos-upgrade-1";
    mockStorage.set("userId", userId);
    mockStorage.set("activePositions", []);

    // Initial state: Audit record with HISTORICAL_DATA_UNAVAILABLE
    d1AuditLog.set(`pos_close_${posId}`, {
      id: `pos_close_${posId}`,
      user_id: userId,
      action: "POSITION_CLOSED",
      metadata: JSON.stringify({
        positionId: posId,
        symbol: "AVAX/USDT",
        evidenceStatus: "HISTORICAL_DATA_UNAVAILABLE",
        realizedPnl: null,
      }),
      created_at: new Date(1787467000000).toISOString(),
    });

    d1Positions.set(posId, {
      id: posId,
      user_id: userId,
      symbol: "AVAX/USDT",
      side: "BUY",
      entry_price: 30,
      quantity: 10,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo",
      created_at: new Date(1787467000000).toISOString(),
    });

    mockAdapterInstance.fetchPositions.mockResolvedValue([]);
    // Verified closed PnL becomes available
    mockAdapterInstance.fetchClosedPnl.mockResolvedValue([
      {
        symbol: "AVAX/USDT",
        orderId: "ord-avax-close",
        side: "sell",
        qty: 10,
        closedPnl: 45,
        avgEntryPrice: 30,
        avgExitPrice: 34.5,
        updatedTime: 1787467050000,
      }
    ]);

    const req = new Request(`http://bot/execution-status?positionId=${posId}`, { method: "GET" });
    await bot.fetch(req);

    // Audit record should be UPGRADED to VERIFIED_EXCHANGE_RECORD
    const upgraded = d1AuditLog.get(`pos_close_${posId}`);
    const upgradedMeta = JSON.parse(upgraded.metadata);
    expect(upgradedMeta.evidenceStatus).toBe("VERIFIED_EXCHANGE_RECORD");
    expect(upgradedMeta.realizedPnl).toBe(45);

    // Now test downgrade protection: simulate subsequent run with HISTORICAL_DATA_UNAVAILABLE
    mockAdapterInstance.fetchClosedPnl.mockResolvedValue([]);
    d1Positions.set(posId, {
      id: posId,
      user_id: userId,
      symbol: "AVAX/USDT",
      side: "BUY",
      entry_price: 30,
      quantity: 10,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo",
    });

    await bot.fetch(req);
    // Must remain VERIFIED_EXCHANGE_RECORD, never downgraded
    const protectedAudit = d1AuditLog.get(`pos_close_${posId}`);
    const protectedMeta = JSON.parse(protectedAudit.metadata);
    expect(protectedMeta.evidenceStatus).toBe("VERIFIED_EXCHANGE_RECORD");
    expect(protectedMeta.realizedPnl).toBe(45);
  });

  // --------------------------------------------------------------------------
  // Test 8: Zero-row recovery verifies 5-point audit proof; fails closed if proof missing
  // --------------------------------------------------------------------------
  it("Test 8: Zero-row recovery verifies 5-point audit proof; fails closed if proof missing", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-8";
    const posIdValid = "pos-zero-valid";
    const posIdInvalid = "pos-zero-invalid";
    mockStorage.set("userId", userId);
    mockStorage.set("isActive", true);

    mockStorage.set("activePositions", [
      { id: posIdValid, symbol: "BTC/USDT", side: "BUY", size: 0.1, exchange: "bybit" },
      { id: posIdInvalid, symbol: "ETH/USDT", side: "BUY", size: 1.0, exchange: "bybit" },
    ]);
    mockStorage.set("lock:ticker:BTC/USDT", posIdValid);
    mockStorage.set("lock:ticker:ETH/USDT", posIdInvalid);

    // Valid position: absent from D1, but 5-point audit proof exists in audit_log
    d1AuditLog.set(`pos_close_${posIdValid}`, {
      id: `pos_close_${posIdValid}`,
      user_id: userId,
      action: "POSITION_CLOSED",
      metadata: JSON.stringify({
        positionId: posIdValid,
        evidenceStatus: "VERIFIED_EXCHANGE_RECORD",
      }),
      created_at: new Date().toISOString(),
    });

    // Invalid position: absent from D1, and NO valid audit record exists
    // (d1Positions has neither posIdValid nor posIdInvalid)

    mockAdapterInstance.fetchPositions.mockResolvedValue([]);

    // Trigger reconciliation via alarm()
    await bot.alarm();

    // Valid position must have its DO state and ticker lock released
    const activePositions = (mockStorage.get("activePositions") || []) as any[];
    const validRemaining = activePositions.find((p: any) => p && p.id === posIdValid);
    expect(validRemaining).toBeUndefined();
    expect(mockStorage.has(`lock:ticker:BTC/USDT`)).toBe(false);

    // Invalid position: proof failed, fails closed (DO state and lock preserved)
    const invalidRemaining = activePositions.find((p: any) => p && p.id === posIdInvalid);
    expect(invalidRemaining).toBeDefined();
    expect(mockStorage.has(`lock:ticker:ETH/USDT`)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Test 9: Verified record conflict preserves immutable original
  // --------------------------------------------------------------------------
  it("Test 9: Verified record conflict preserves immutable original", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-9";
    const posId = "pos-conflict-1";
    mockStorage.set("userId", userId);
    mockStorage.set("activePositions", []);

    // Stored verified record: PnL = 100, closePrice = 50000
    d1AuditLog.set(`pos_close_${posId}`, {
      id: `pos_close_${posId}`,
      user_id: userId,
      action: "POSITION_CLOSED",
      metadata: JSON.stringify({
        positionId: posId,
        symbol: "BTC/USDT",
        evidenceStatus: "VERIFIED_EXCHANGE_RECORD",
        realizedPnl: 100,
        closePrice: 50000,
        closedQty: 0.1,
      }),
      created_at: new Date().toISOString(),
    });

    d1Positions.set(posId, {
      id: posId,
      user_id: userId,
      symbol: "BTC/USDT",
      side: "BUY",
      entry_price: 49000,
      quantity: 0.1,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo",
      created_at: new Date(1787467000000).toISOString(),
    });

    mockAdapterInstance.fetchPositions.mockResolvedValue([]);
    // Divergent incoming closed PnL: PnL = 250, closePrice = 51500
    mockAdapterInstance.fetchClosedPnl.mockResolvedValue([
      {
        symbol: "BTC/USDT",
        orderId: "ord-divergent",
        side: "sell",
        qty: 0.1,
        closedPnl: 250,
        avgEntryPrice: 49000,
        avgExitPrice: 51500,
        updatedTime: 1787467100000,
      }
    ]);

    const req = new Request(`http://bot/execution-status?positionId=${posId}`, { method: "GET" });
    await bot.fetch(req);

    // Verify original immutable record was preserved
    const audit = d1AuditLog.get(`pos_close_${posId}`);
    const meta = JSON.parse(audit.metadata);
    expect(meta.realizedPnl).toBe(100);
    expect(meta.closePrice).toBe(50000);

    // Verify diagnostic conflict record was emitted
    const conflictEntries = Array.from(d1AuditLog.values()).filter(a => a.action === 'AUDIT_CONFLICT_DETECTED');
    expect(conflictEntries.length).toBeGreaterThan(0);
    const conflictMeta = JSON.parse(conflictEntries[0].metadata);
    expect(conflictMeta.positionId).toBe(posId);
    expect(conflictMeta.stored.realizedPnl).toBe(100);
    expect(conflictMeta.incoming.realizedPnl).toBe(250);
  });

  // --------------------------------------------------------------------------
  // Test 10: Partial closure (size > 0) keeps position OPEN
  // --------------------------------------------------------------------------
  it("Test 10: Partial closure (size > 0) keeps position OPEN", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-10";
    const posId = "pos-partial-1";
    mockStorage.set("userId", userId);
    mockStorage.set("activePositions", []);

    d1Positions.set(posId, {
      id: posId,
      user_id: userId,
      symbol: "BTC/USDT",
      side: "BUY",
      entry_price: 50000,
      quantity: 1.0,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo",
    });

    // Exchange reports position still partially open with size 0.4
    mockAdapterInstance.fetchPositions.mockResolvedValue([
      {
        symbol: "BTC/USDT",
        side: "Buy",
        size: 0.4,
      }
    ]);

    const req = new Request(`http://bot/execution-status?positionId=${posId}`, { method: "GET" });
    const res = await bot.fetch(req);
    expect(res.status).toBe(200);

    // Position must remain OPEN in D1
    expect(d1Positions.has(posId)).toBe(true);
    expect(d1Positions.get(posId).status).toBe("OPEN");
    // No closure audit log written
    expect(d1AuditLog.has(`pos_close_${posId}`)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 11: Fair batching quarantines failing positions and advances queue
  // --------------------------------------------------------------------------
  it("Test 11: Fair batching quarantines failing positions and advances queue", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-11";
    mockStorage.set("userId", userId);
    mockStorage.set("isActive", true);
    mockStorage.set("activePositions", []);

    // Set up 5 absent positions in D1
    for (let i = 1; i <= 5; i++) {
      d1Positions.set(`pos-queue-${i}`, {
        id: `pos-queue-${i}`,
        user_id: userId,
        symbol: `COIN${i}/USDT`,
        side: "BUY",
        entry_price: 10,
        quantity: 1,
        status: "OPEN",
        entry_status: "FILLED",
        exchange: "bybit",
        environment: "demo",
      });
    }

    // pos-queue-1 throws an error on fetchPositions (exposure check fails)
    mockAdapterInstance.fetchPositions.mockImplementation(async (cat: string, sym?: string) => {
      if (sym && sym.includes("COIN1")) {
        throw new Error("Bybit network error on COIN1");
      }
      return [];
    });
    mockAdapterInstance.fetchClosedPnl.mockResolvedValue([]);

    await bot.alarm();

    // 1. pos-queue-1 should fail and be quarantined in lock:reconciliationRetries
    const retriesRaw = mockStorage.get("lock:reconciliationRetries");
    const retriesMap = new Map(retriesRaw || []);
    expect(retriesMap.has("pos-queue-1")).toBe(true);
    const retry1: any = retriesMap.get("pos-queue-1");
    expect(retry1.failures).toBe(1);
    expect(retry1.quarantinedUntil).toBeGreaterThan(Date.now() + 50000);

    // 2. pos-queue-2 and pos-queue-3 should have completed closure (batch limit is 3)
    expect(d1Positions.has("pos-queue-2")).toBe(false);
    expect(d1Positions.has("pos-queue-3")).toBe(false);

    // 3. pos-queue-4 and pos-queue-5 remain for next batch, so continuation alarm scheduled
    expect(scheduledAlarmTime).toBeGreaterThan(0);
    expect(scheduledAlarmTime).toBeLessThanOrEqual(Date.now() + 6000); // 5s continuation alarm
  });

  // --------------------------------------------------------------------------
  // Test 12: Crash Boundary C recovery purges DO storage on restart
  // --------------------------------------------------------------------------
  it("Test 12: Crash Boundary C recovery purges DO storage on restart", async () => {
    const bot = new TradingBot(mockState, mockEnv);
    const userId = "usr-test-12";
    const posId = "pos-crash-c";
    mockStorage.set("userId", userId);
    mockStorage.set("isActive", true);

    // DO storage has stale position (Worker died before persistState)
    mockStorage.set("activePositions", [
      { id: posId, symbol: "BTC/USDT", side: "BUY", size: 0.1, exchange: "bybit" }
    ]);
    mockStorage.set("lock:ticker:BTC/USDT", posId);

    // D1 commit succeeded before crash: D1 row deleted, audit log persisted
    // (d1Positions does not contain posId)
    d1AuditLog.set(`pos_close_${posId}`, {
      id: `pos_close_${posId}`,
      user_id: userId,
      action: "POSITION_CLOSED",
      metadata: JSON.stringify({
        positionId: posId,
        evidenceStatus: "VERIFIED_EXCHANGE_RECORD",
        realizedPnl: 75,
      }),
      created_at: new Date().toISOString(),
    });

    mockAdapterInstance.fetchPositions.mockResolvedValue([]);

    // DO restart triggers alarm
    await bot.alarm();

    // On restart reconciliation, zero-row recovery checks Bybit flat + 5-point audit proof
    // DO storage must be cleanly purged!
    const activePositions = (mockStorage.get("activePositions") || []) as any[];
    const posRemaining = activePositions.find((p: any) => p && p.id === posId);
    expect(posRemaining).toBeUndefined();
    expect(mockStorage.has("lock:ticker:BTC/USDT")).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 13: Parity between /execution-status and alarm()
  // --------------------------------------------------------------------------
  it("Test 13: Parity between /execution-status and alarm()", async () => {
    // Both paths must produce identical audit structures and D1 state
    const posIdAlarm = "pos-parity-alarm";
    const posIdEndpoint = "pos-parity-endpoint";
    const userId = "usr-test-13";
    const entryTime = 1787467000000;

    d1Positions.set(posIdAlarm, {
      id: posIdAlarm,
      user_id: userId,
      symbol: "LINK/USDT",
      side: "BUY",
      entry_price: 15,
      quantity: 10,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo",
      created_at: new Date(entryTime).toISOString(),
    });

    d1Positions.set(posIdEndpoint, {
      id: posIdEndpoint,
      user_id: userId,
      symbol: "LINK/USDT",
      side: "BUY",
      entry_price: 15,
      quantity: 10,
      status: "OPEN",
      entry_status: "FILLED",
      exchange: "bybit",
      environment: "demo",
      created_at: new Date(entryTime).toISOString(),
    });

    mockAdapterInstance.fetchPositions.mockResolvedValue([]);
    mockAdapterInstance.fetchClosedPnl.mockResolvedValue([
      {
        symbol: "LINK/USDT",
        orderId: "ord-link-close",
        side: "sell",
        qty: 10,
        closedPnl: 25,
        avgEntryPrice: 15,
        avgExitPrice: 17.5,
        updatedTime: entryTime + 2000,
      }
    ]);

    // Path 1: alarm()
    const bot1 = new TradingBot(mockState, mockEnv);
    mockStorage.set("userId", userId);
    mockStorage.set("isActive", true);
    mockStorage.set("activePositions", []);
    await bot1.alarm();

    // Path 2: /execution-status
    const bot2 = new TradingBot(mockState, mockEnv);
    const req = new Request(`http://bot/execution-status?positionId=${posIdEndpoint}`, { method: "GET" });
    await bot2.fetch(req);

    // Both positions should be deleted from D1
    expect(d1Positions.has(posIdAlarm)).toBe(false);
    expect(d1Positions.has(posIdEndpoint)).toBe(false);

    // Both audit logs should exist and match in structural fields
    expect(d1AuditLog.has(`pos_close_${posIdAlarm}`)).toBe(true);
    expect(d1AuditLog.has(`pos_close_${posIdEndpoint}`)).toBe(true);

    const metaAlarm = JSON.parse(d1AuditLog.get(`pos_close_${posIdAlarm}`).metadata);
    const metaEndpoint = JSON.parse(d1AuditLog.get(`pos_close_${posIdEndpoint}`).metadata);

    expect(metaAlarm.evidenceStatus).toBe(metaEndpoint.evidenceStatus);
    expect(metaAlarm.evidenceStatus).toBe("VERIFIED_EXCHANGE_RECORD");
    expect(metaAlarm.realizedPnl).toBe(metaEndpoint.realizedPnl);
    expect(metaAlarm.closePrice).toBe(metaEndpoint.closePrice);
    expect(metaAlarm.closedQty).toBe(metaEndpoint.closedQty);
    expect(metaAlarm.closeReason).toBe(metaEndpoint.closeReason);
  });
});
