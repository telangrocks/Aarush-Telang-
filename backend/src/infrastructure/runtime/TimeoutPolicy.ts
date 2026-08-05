import { Result, ok, fail, createDomainError, DomainError } from '../../domain/types/Result';

export interface TimeoutConfig {
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly websocketHeartbeatTimeoutMs: number;
  readonly reconciliationTimeoutMs: number;
}

export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  connectTimeoutMs: 5000,
  requestTimeoutMs: 10000,
  websocketHeartbeatTimeoutMs: 15000,
  reconciliationTimeoutMs: 30000,
};

export class TimeoutPolicy {
  constructor(private readonly config: TimeoutConfig = DEFAULT_TIMEOUT_CONFIG) {}

  public get connectTimeout(): number {
    return this.config.connectTimeoutMs;
  }

  public get requestTimeout(): number {
    return this.config.requestTimeoutMs;
  }

  public get websocketHeartbeatTimeout(): number {
    return this.config.websocketHeartbeatTimeoutMs;
  }

  public get reconciliationTimeout(): number {
    return this.config.reconciliationTimeoutMs;
  }

  public async executeWithTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number = this.config.requestTimeoutMs,
    operationName: string = 'operation'
  ): Promise<Result<T, DomainError>> {
    const controller = new AbortController();
    let timer: any = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Operation '${operationName}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        operation(controller.signal),
        timeoutPromise,
      ]);
      clearTimeout(timer);
      return ok(result);
    } catch (err: any) {
      clearTimeout(timer);
      const message = err?.message || String(err);
      if (message.includes('timed out') || err?.name === 'AbortError') {
        return fail(createDomainError('EXCHANGE_ERROR', `[TimeoutPolicy] ${message}`, { operationName, timeoutMs }));
      }
      return fail(createDomainError('INTERNAL_ERROR', message, { operationName }));
    }
  }
}
