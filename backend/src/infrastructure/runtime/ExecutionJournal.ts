import { LruTtlCache } from '../cache/LruTtlCache';
import { WebCryptoSigner } from '../crypto/WebCryptoSigner';

export type JournalState = 'SUBMITTING' | 'COMMITTED' | 'RECONCILING' | 'COMPLETED' | 'FAILED';

export interface JournalRecord<T = unknown> {
  readonly clientOrderId: string;
  readonly workflowId: string;
  readonly intentHash: string;
  readonly state: JournalState;
  readonly payload: unknown;
  readonly result?: T;
  readonly errorMsg?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class ExecutionJournal {
  private cache = new LruTtlCache<string, JournalRecord>(100, 30 * 60 * 1000); // 30 mins
  private activeLocks = new Set<string>();

  public async createIntentHash(userId: string, symbol: string, side: string, amount: number): Promise<string> {
    const raw = `${userId}:${symbol}:${side}:${amount}`;
    return WebCryptoSigner.hashSha256(raw);
  }

  public acquireLock(clientOrderId: string): boolean {
    if (this.activeLocks.has(clientOrderId)) {
      return false; // Lock already held
    }
    this.activeLocks.add(clientOrderId);
    return true;
  }

  public releaseLock(clientOrderId: string): void {
    this.activeLocks.delete(clientOrderId);
  }

  public getRecord(clientOrderId: string): JournalRecord | null {
    return this.cache.get(clientOrderId);
  }

  public recordSubmitting(clientOrderId: string, workflowId: string, intentHash: string, payload: unknown): JournalRecord {
    const record: JournalRecord = {
      clientOrderId,
      workflowId,
      intentHash,
      state: 'SUBMITTING',
      payload,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.cache.set(clientOrderId, record);
    return record;
  }

  public recordStateTransition<T>(clientOrderId: string, state: JournalState, result?: T, errorMsg?: string): JournalRecord | null {
    const existing = this.cache.get(clientOrderId);
    if (!existing) return null;

    const updated: JournalRecord = {
      ...existing,
      state,
      result: result !== undefined ? result : existing.result,
      errorMsg: errorMsg !== undefined ? errorMsg : existing.errorMsg,
      updatedAt: Date.now(),
    };

    this.cache.set(clientOrderId, updated);
    return updated;
  }

  public getRecoveryCheckpoints(): JournalRecord[] {
    const records: JournalRecord[] = [];
    // Uncompleted records needing reconciliation / recovery
    const now = Date.now();
    for (const record of (this.cache as any).cache.values()) {
      if (now <= record.expiresAt) {
        const val: JournalRecord = record.value;
        if (val.state === 'SUBMITTING' || val.state === 'COMMITTED' || val.state === 'RECONCILING') {
          records.push(val);
        }
      }
    }
    return records;
  }
}
