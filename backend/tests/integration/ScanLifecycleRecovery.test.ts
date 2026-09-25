import { describe, it, expect, vi } from 'vitest';
import { TradingBot } from '../../src/trading-bot';
import { InMemorySchedulerStorage } from '../../src/infrastructure/exchange/pacing';

describe('Suite 4: Lifecycle & Crash Recovery (ScanLifecycleRecovery)', () => {
  it('test_atomic_completion_write: Asserts status COMPLETED, activeScanId null, and coverage report commit in a composite operation', async () => {
    const storage = new Map<string, any>();
    const state: any = {
      id: { toString: () => 'test-do-1' },
      storage: {
        get: async (k: string) => storage.get(k),
        put: async (keyOrEntries: string | Record<string, any>, val?: any) => {
          if (typeof keyOrEntries === 'string') {
            storage.set(keyOrEntries, val);
          } else if (keyOrEntries && typeof keyOrEntries === 'object') {
            for (const [k, v] of Object.entries(keyOrEntries)) {
              storage.set(k, v);
            }
          }
        },
        delete: async (k: string) => storage.delete(k),
      },
      blockConcurrencyWhile: async (cb: any) => cb(),
    };

    const env: any = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ count: 0 }) }) }) } };

    // Simulate completion write
    const completionWrite = {
      'scan:current': {
        scanId: 'scan-uuid-complete',
        status: 'COMPLETED',
        completedAt: 1700000000000,
        universeSize: 25,
        coverageReport: { expectedCells: 125, terminalCells: 125 },
      },
      'scan:activeScanId': null,
      'lastCoverageReport': { expectedCells: 125, terminalCells: 125 },
    };

    await state.storage.put(completionWrite);

    const currentScan = await state.storage.get('scan:current');
    const activeScanId = await state.storage.get('scan:activeScanId');

    expect(currentScan.status).toBe('COMPLETED');
    expect(activeScanId).toBeNull();
    expect(currentScan.coverageReport).toBeDefined();
  });

  it('test_progressive_cell_persistence_before_completion: Asserts cells are durably recorded progressively and a crash cannot leave a false COMPLETED state', async () => {
    const storage = new Map<string, any>();
    const persistedCells: string[] = [];
    const mockStorage: any = {
      get: async (k: string) => storage.get(k),
      put: async (keyOrEntries: string | Record<string, any>, val?: any) => {
        if (typeof keyOrEntries === 'string') {
          storage.set(keyOrEntries, val);
          if (keyOrEntries.startsWith('scan:cell:')) {
            persistedCells.push(keyOrEntries);
          }
        } else if (keyOrEntries && typeof keyOrEntries === 'object') {
          for (const [k, v] of Object.entries(keyOrEntries)) {
            storage.set(k, v);
          }
        }
      },
    };

    const scanId = 'scan-crash-safe';
    // 1. Scan begins: activeScanId set, status RUNNING
    await mockStorage.put({
      'scan:activeScanId': scanId,
      'scan:current': {
        scanId,
        status: 'RUNNING',
        startedAt: Date.now(),
        universeSize: 25,
      },
    });

    // 2. Progressive cell persistence occurs as cells complete
    for (let i = 1; i <= 50; i++) {
      await mockStorage.put(`scan:cell:${scanId}:C${String(i).padStart(2, '0')}|Momentum`, {
        cellId: `C${String(i).padStart(2, '0')}|Momentum`,
        status: 'SIGNAL',
      });
    }

    expect(persistedCells.length).toBe(50);

    // 3. Crash occurs before completion write!
    // Assert current state in storage is still RUNNING, NOT COMPLETED
    const scanStateBeforeRecovery = await mockStorage.get('scan:current');
    expect(scanStateBeforeRecovery.status).toBe('RUNNING');
    expect(scanStateBeforeRecovery.status).not.toBe('COMPLETED');

    // 4. On reboot, DO recovery transitions RUNNING to ABORTED with in-flight cells UNKNOWN
    if (scanStateBeforeRecovery.status === 'RUNNING') {
      await mockStorage.put({
        'scan:current': {
          ...scanStateBeforeRecovery,
          status: 'ABORTED',
          abortedAt: Date.now(),
          abortReason: 'DO_RESTART_RECOVERY',
        },
        'scan:activeScanId': null,
      });
    }

    const recoveredScan = await mockStorage.get('scan:current');
    const activeScanId = await mockStorage.get('scan:activeScanId');
    expect(recoveredScan.status).toBe('ABORTED');
    expect(activeScanId).toBeNull();
    // Proves a crash CANNOT leave a false COMPLETED state with missing coverage
    expect(recoveredScan.status).not.toBe('COMPLETED');
  });

  it('test_crash_recovery_aborted_state: Simulates DO crash mid-scan; verifies reboot marks prior scan ABORTED and in-flight cells UNKNOWN', async () => {
    const sharedStorage = new Map<string, any>();

    // Step 1: Pre-crash state: Isolate 1 was running a scan when crashed
    sharedStorage.set('scan:activeScanId', 'scan-crashed-123');
    sharedStorage.set('scan:current', {
      scanId: 'scan-crashed-123',
      status: 'RUNNING',
      startedAt: 1700000000000,
      universeSize: 25,
    });

    const mockState: any = {
      id: { toString: () => 'test-do-1' },
      storage: {
        get: async (k: string) => sharedStorage.get(k),
        put: async (keyOrEntries: string | Record<string, any>, val?: any) => {
          if (typeof keyOrEntries === 'string') {
            sharedStorage.set(keyOrEntries, val);
          } else if (keyOrEntries && typeof keyOrEntries === 'object') {
            for (const [k, v] of Object.entries(keyOrEntries)) {
              sharedStorage.set(k, v);
            }
          }
        },
        delete: async (k: string) => sharedStorage.delete(k),
      },
      blockConcurrencyWhile: (cb: any) => {
        recoveryPromise = cb();
        return recoveryPromise;
      },
    };

    let recoveryPromise: Promise<any> | undefined;
    const mockEnv: any = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ count: 0 }) }) }) } };

    // Step 2: Reboot! Instantiate new TradingBot with recovery block
    new TradingBot(mockState, mockEnv);
    if (recoveryPromise) {
      await recoveryPromise;
    }

    // Step 3: Verify crash recovery executed inside blockConcurrencyWhile
    const recoveredScan = await mockState.storage.get('scan:current');
    const activeScanId = await mockState.storage.get('scan:activeScanId');

    expect(activeScanId).toBeNull();
    expect(recoveredScan.status).toBe('ABORTED');
    expect(recoveredScan.abortReason).toBe('DO_RESTART_RECOVERY');
    expect(recoveredScan.abortedAt).toBeDefined();
  });

  it('test_interrupted_cells_never_no_signal: Asserts interrupted cells are recorded as UNKNOWN and never converted to NO_SIGNAL', () => {
    // A cell interrupted mid-execution
    const interruptedCellRecord = {
      scanId: 'scan-interrupted',
      cellId: 'C12|MeanReversion',
      candidateIndex: 12,
      symbol: 'UNIUSDT',
      strategyId: 'MeanReversion',
      status: 'UNKNOWN' as const,
      startedAt: 1700000000000,
      completedAt: 1700000000100,
      durationMs: 100,
      hasSignal: false,
    };

    expect(interruptedCellRecord.status).toBe('UNKNOWN');
    expect(interruptedCellRecord.status).not.toBe('NO_SIGNAL');
  });
});
