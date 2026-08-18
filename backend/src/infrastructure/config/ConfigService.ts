export interface ExchangeConfig {
  readonly timeoutMs: number;
  readonly recvWindowMs: number;
}

export interface CacheConfig {
  readonly maxCapacity: number;
  readonly ttlMs: number;
}

export interface TradingConfig {
  readonly maxPositionUsdt: number;
  readonly defaultStopLossPercentage: number;
  readonly globalHalt: boolean;
}

export interface RetryConfig {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterFactor: number;
}

export interface IConfigService {
  readonly exchangeConfig: ExchangeConfig;
  readonly cacheConfig: CacheConfig;
  readonly tradingConfig: TradingConfig;
  readonly retryConfig: RetryConfig;
  getEncryptionKey(): string;
  getJwtSecret(): string;
}

export class ConfigService implements IConfigService {
  readonly exchangeConfig: ExchangeConfig;
  readonly cacheConfig: CacheConfig;
  readonly tradingConfig: TradingConfig;
  readonly retryConfig: RetryConfig;

  constructor(private env: Record<string, unknown> = {}) {
    this.exchangeConfig = {
      timeoutMs: Number(env.EXCHANGE_TIMEOUT_MS) || 10000,
      recvWindowMs: Number(env.RECV_WINDOW_MS) || 10000,
    };

    this.cacheConfig = {
      maxCapacity: Number(env.CACHE_MAX_CAPACITY) || 50,
      ttlMs: Number(env.CACHE_TTL_MS) || 15 * 60 * 1000, // 15 minutes
    };

    this.tradingConfig = {
      maxPositionUsdt: Number(env.MAX_POSITION_USDT) || 1000,
      defaultStopLossPercentage: Number(env.DEFAULT_STOP_LOSS_PCT) || 1.0,
      globalHalt: env.GLOBAL_TRADING_HALT === 'true',
    };

    this.retryConfig = {
      maxRetries: Number(env.MAX_RETRIES) || 3,
      baseDelayMs: Number(env.RETRY_BASE_DELAY_MS) || 250,
      maxDelayMs: Number(env.RETRY_MAX_DELAY_MS) || 1000,
      jitterFactor: Number(env.RETRY_JITTER) || 0.2,
    };
  }

  public getEncryptionKey(): string {
    return (this.env.ENCRYPTION_KEY as string) || '';
  }

  public getJwtSecret(): string {
    return (this.env.JWT_SECRET as string) || '';
  }
}
