import { LruTtlCache } from '../cache/LruTtlCache';
import { WebCryptoSigner } from '../crypto/WebCryptoSigner';

export interface ExecutionState<T = unknown> {
  readonly executionId: string;
  readonly status: 'PENDING' | 'COMPLETED' | 'FAILED';
  readonly result?: T;
  readonly createdAt: number;
}

export class ExecutionIdempotencyService {
  private cache = new LruTtlCache<string, ExecutionState>(100, 15 * 60 * 1000); // 15 mins

  public async generateIdempotencyKey(payload: Record<string, unknown>): Promise<string> {
    const jsonStr = JSON.stringify(payload);
    const hash = await WebCryptoSigner.hashSha256(jsonStr);
    return `idem_${hash}`;
  }

  public getExecution(key: string): ExecutionState | null {
    return this.cache.get(key);
  }

  public markPending(key: string): void {
    this.cache.set(key, {
      executionId: key,
      status: 'PENDING',
      createdAt: Date.now(),
    });
  }

  public markCompleted<T>(key: string, result: T): void {
    this.cache.set(key, {
      executionId: key,
      status: 'COMPLETED',
      result,
      createdAt: Date.now(),
    });
  }

  public markFailed(key: string): void {
    this.cache.delete(key);
  }
}
