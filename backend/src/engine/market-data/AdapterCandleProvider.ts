import { ICandleProvider } from './CandleProvider';
import { Timeframe } from './Timeframe';
import { NormalizedCandle } from './MarketSnapshot';
import { IExchangeAdapter } from '../../infrastructure/exchange/types';
import { IExchangeProvider } from '../../exchanges/IExchangeProvider';
import { Ticker } from '../../exchanges/models/NormalizedDomain';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';
import { StructuredLogger } from '../../infrastructure/telemetry/Telemetry';
import { UnifiedError } from '../../exchanges/models/UnifiedError';

export class AdapterCandleProvider implements ICandleProvider {
  private logger = new StructuredLogger();

  constructor(private adapter: IExchangeProvider | IExchangeAdapter) {}

  async fetchCandles(symbol: string, timeframe: Timeframe, limit: number = 100): Promise<NormalizedCandle[]> {
    const klines = await this.withRetry(
      () => this.adapter.fetchKlines(symbol, timeframe, limit),
      'fetchKlines',
      symbol,
    );

    const mapped = klines.map((k: any) => ({
      openTime: typeof k.openTime === 'number' ? k.openTime : typeof k.timestamp === 'number' ? k.timestamp : 0,
      timestamp: typeof k.openTime === 'number' ? k.openTime : typeof k.timestamp === 'number' ? k.timestamp : 0,
      open: typeof k.open === 'number' ? k.open : parseFloat(k.open || 0),
      high: typeof k.high === 'number' ? k.high : parseFloat(k.high || 0),
      low: typeof k.low === 'number' ? k.low : parseFloat(k.low || 0),
      close: typeof k.close === 'number' ? k.close : parseFloat(k.close || 0),
      volume: typeof k.volume === 'number' ? k.volume : parseFloat(k.volume || 0),
    }));

    return CandleValidator.sanitizeAndSortCandles(mapped);
  }

  async fetchTicker(symbol: string): Promise<Ticker | null> {
    return this.withRetry(
      () => this.adapter.fetchTicker(symbol),
      'fetchTicker',
      symbol,
    );
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    symbol: string,
  ): Promise<T> {
    const maxRetries = 2;
    const baseDelayMs = 500;
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err: any) {
        lastError = err;
        const isRetryable = this.isRetryableError(err);
        if (!isRetryable || attempt === maxRetries) {
          throw err;
        }
        const delay = baseDelayMs * Math.pow(2, attempt);
        this.logger.warn(`[AdapterCandleProvider] Retrying ${operationName}`, {
          symbol,
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  private isRetryableError(err: any): boolean {
    if (err instanceof UnifiedError) {
      return (
        err.code === 'EXCHANGE_TIMEOUT' ||
        err.code === 'RATE_LIMIT_EXCEEDED' ||
        err.code === 'EXCHANGE_NOT_REACHABLE' ||
        err.code === 'UNKNOWN_EXCHANGE_ERROR'
      );
    }
    return err instanceof TypeError;
  }
}
