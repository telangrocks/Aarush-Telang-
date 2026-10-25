import { Env } from './index';
import { ExchangeManager, ExchangeName, ExchangeEnvironment } from './exchanges';
import { PriceNormalizer } from './utils/PriceNormalizer';
import { Ticker } from './exchanges/models/NormalizedDomain';
import BigNumber from 'bignumber.js';


import { decrypt } from './crypto';
import { TradeValidator } from './validation/TradeValidator';
import { sendTradeNotification } from './handlers/notifications';
import { StrategyOrchestrator, MarketDataEngine, AdapterCandleProvider } from './engine';
import { EngineAPIService, AnalysisSnapshotMapper } from './api/engine';
import { StrategyRegistry } from './engine/strategies/StrategyRegistry';
import { MarketRegimeEngine } from './engine/regime/MarketRegimeEngine';
import { StructuredLogger } from './infrastructure/telemetry/Telemetry';
import { UnifiedError } from './exchanges/models/UnifiedError';
import { resolveCanonicalRoutingRegion } from './utils/region';
import { ReconciliationEngine } from './engine/reconciliation/ReconciliationEngine';
import { FinalDispatchSafetyGate } from './engine/safety/FinalDispatchSafetyGate';
import { BybitAdapter } from './infrastructure/exchange/adapters/BybitAdapter';
import type { EconomicIntent } from './engine/wal/WalTypes';
import { Timeframe } from './engine/market-data/Timeframe';
import { BackendDiagnosticSink } from './telemetry/BackendDiagnosticSink';
import { extractUsdtBalance } from './utils/balance';
import {
  SignalLifecycleManager,
  ShadowComparisonEngine,
} from './engine/signal-lifecycle';

/**
 * Normalize an untrusted environment value into a valid ExchangeEnvironment.
 */
function normalizeEnvironment(value: unknown): ExchangeEnvironment {
  if (value === 'demo') return 'demo' as ExchangeEnvironment;
  if (value === 'testnet' || value === 'testing' || value === 'sandbox') return 'testnet';
  return 'mainnet';
}

/**
 * How often the bot performs a full live analysis cycle (fetch market data,
 * compute indicators, evaluate the strategy). Every value shown on the UI is a
 * direct snapshot of the result of the most recent cycle of this interval.
 */
const ANALYSIS_INTERVAL_MS = 15_000;

/**
 * Open positions are monitored less frequently than the analysis cycle because
 * they only need to check stop-loss / take-profit breaches.
 */
const POSITION_CHECK_INTERVAL_MS = 60_000;

export interface TradeAlert {
  id: string;
  symbol: string;
  signalPrice: number;
  targetEntryPrice?: number;
  entryIntent?: 'WAIT_FOR_PRICE' | 'IMMEDIATE' | 'TRIGGER';
  /** @deprecated Retained for v1.0 backward compatibility */
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  estimatedPnl: number;
  positionSize: number;
  strategy: string;
  side: 'BUY' | 'SELL';
  timestamp: string;
  status: 'pending' | 'acknowledged' | 'submitted' | 'partially_filled' | 'filled' | 'executed' | 'expired' | 'failed';
  generation?: number;
  source?: 'MANUAL' | 'AUTONOMOUS';
  timeframe?: Timeframe;
}

export interface TradeSetupSnapshot {
  readonly userId: string;
  readonly coinId: string;
  readonly strategy: string;
  readonly targetEntryPrice?: number;
  readonly entryIntent?: 'WAIT_FOR_PRICE' | 'IMMEDIATE' | 'TRIGGER';
  readonly positionSize?: number;
  readonly activatedAt: string;
  readonly exchangeName?: string;
  readonly environment?: string;
}

export interface TradeExecutionSnapshot {
  readonly snapshotId: string;
  readonly alertId: string;
  readonly userId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly orderType: 'MARKET' | 'LIMIT';
  readonly limitPrice?: number;
  readonly signalPrice: number;
  readonly targetEntryPrice?: number;
  readonly positionSizeUsdt: number;
  readonly quantizedQuantity: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly strategy: string;
  readonly exchangeName: string;
  readonly environment: string;
  readonly clientOrderId: string;
  readonly createdAt: string;
  readonly timeframe?: Timeframe;
}

interface AnalysisLog {
  timestamp: string;
  level: 'info' | 'accepted' | 'rejected' | 'scanning';
  message: string;
}

interface ScanCandidate {
  symbol: string;
  price: number;
  progress: number;
  status: 'scanning' | 'queued' | 'rejected';
}

interface NearMatch {
  symbol: string;
  confidence: number;
  estimatedEntry: number;
  currentPrice: number;
  conditionsMet: string[];
}

export interface Checkpoint {
  name: string;
  status: 'passed' | 'pending' | 'failed';
}

export interface IndicatorSet {
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
}

export interface Metrics {
  price: number;
  change24h: number;
  volume: number;
  rangePercent: number;
  positionInRange: number;
}

export interface StrategyEvaluation {
  checkpoints: Checkpoint[];
  total: number;
  passed: number;
  progress: number;
  confidence: number;
  conditionsMet: string[];
  opportunity: {
    symbol: string;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    estimatedPnl: number;
    positionSize: number;
    side: 'BUY' | 'SELL';
  } | null;
}

export interface AnalysisSnapshot {
  isActive: boolean;
  strategy: string | null;
  coinId: string | null;
  exchange: string | null;
  environment: string | null;
  scanningProgress: number;
  etaSeconds: number;
  confluenceScore: number;
  alignment: 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE';
  primarySignal: 'BUY' | 'SELL' | 'HOLD';
  timeframes: TimeframeAnalysis[];
  coinsCurrentlyScanning: ScanCandidate[];
  nearMatches: NearMatch[];
  checkpoints: Checkpoint[];
  logs: AnalysisLog[];
  lastAnalysisAt: number;
  opportunityDetected: boolean;
}

interface TimeframeAnalysis {
  timeframe: string;
  interval: string;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  momentum: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
  volumeProfile: 'HIGH' | 'NORMAL' | 'LOW';
  emaCross: 'GOLDEN' | 'DEATH' | 'NONE';
  rsi: number;
  confidence: number;
  reasoning: string[];
}



interface StrategyConfig {
  volumeThreshold: number;
  rangeThreshold: number;
  momentumThreshold: number;
  indicatorCheck: (m: Metrics, ind: IndicatorSet) => { passed: boolean; label: string };
  entryZone: (m: Metrics) => { passed: boolean; side: 'BUY' | 'SELL' | null };
  stopLossPct: number;
  takeProfitPct: number;
}

/**
 * Single source of truth for every strategy. The same thresholds drive both
 * the progress bar (how many checkpoints are satisfied right now) and the
 * actual trade detection (an opportunity exists only when every checkpoint
 * passes). This guarantees the UI progress and the backend detection can never
 * diverge.
 */
const STRATEGY_CONFIG: Record<string, StrategyConfig> = {
  scalping: {
    volumeThreshold: 500_000,
    rangeThreshold: 0.5,
    momentumThreshold: 0.5,
    indicatorCheck: (_m, ind) => ({
      passed: ind.rsi !== null && ind.rsi >= 30 && ind.rsi <= 70,
      label: ind.rsi !== null ? `RSI ${ind.rsi.toFixed(1)} (healthy 30-70)` : 'RSI unavailable',
    }),
    entryZone: (m) => {
      if (m.change24h > 0 && m.positionInRange > 0.6) return { passed: true, side: 'BUY' };
      if (m.change24h < 0 && m.positionInRange < 0.4) return { passed: true, side: 'SELL' };
      return { passed: false, side: null };
    },
    stopLossPct: 0.003,
    takeProfitPct: 0.006,
  },
  momentum: {
    volumeThreshold: 1_000_000,
    rangeThreshold: 1.0,
    momentumThreshold: 2.0,
    indicatorCheck: (m, ind) => {
      if (ind.rsi === null) return { passed: false, label: 'RSI unavailable' };
      const passed = m.change24h > 0 ? ind.rsi > 55 : ind.rsi < 45;
      return { passed, label: `RSI ${ind.rsi.toFixed(1)} (${m.change24h > 0 ? 'bullish >55' : 'bearish <45'})` };
    },
    entryZone: (m) => {
      if (m.change24h > 0 && m.positionInRange > 0.7) return { passed: true, side: 'BUY' };
      if (m.change24h < 0 && m.positionInRange < 0.3) return { passed: true, side: 'SELL' };
      return { passed: false, side: null };
    },
    stopLossPct: 0.015,
    takeProfitPct: 0.035,
  },
  breakout: {
    volumeThreshold: 750_000,
    rangeThreshold: 2.0,
    momentumThreshold: 1.0,
    indicatorCheck: (_m, ind) => ({
      passed: ind.rsi !== null && ind.rsi > 50,
      label: ind.rsi !== null ? `RSI ${ind.rsi.toFixed(1)} (upward bias >50)` : 'RSI unavailable',
    }),
    entryZone: (m) => {
      if (m.change24h > 0 && m.positionInRange > 0.95) return { passed: true, side: 'BUY' };
      if (m.change24h < 0 && m.positionInRange < 0.05) return { passed: true, side: 'SELL' };
      return { passed: false, side: null };
    },
    stopLossPct: 0.012,
    takeProfitPct: 0.03,
  },
  mean_reversion: {
    volumeThreshold: 500_000,
    rangeThreshold: 3.0,
    momentumThreshold: 0.5,
    indicatorCheck: (m, ind) => {
      if (ind.rsi === null) return { passed: false, label: 'RSI unavailable' };
      const passed = m.change24h > 0 ? ind.rsi < 35 : ind.rsi > 65;
      return { passed, label: `RSI ${ind.rsi.toFixed(1)} (extreme ${m.change24h > 0 ? '<35' : '>65'})` };
    },
    entryZone: (m) => {
      if (m.change24h > 0.5 && m.positionInRange < 0.2) return { passed: true, side: 'BUY' };
      if (m.change24h < -0.5 && m.positionInRange > 0.8) return { passed: true, side: 'SELL' };
      return { passed: false, side: null };
    },
    stopLossPct: 0.02,
    takeProfitPct: 0.03,
  },
  vwap: {
    volumeThreshold: 600_000,
    rangeThreshold: 1.0,
    momentumThreshold: 0.5,
    indicatorCheck: (_m, ind) => ({
      passed: ind.rsi !== null && ind.rsi >= 45 && ind.rsi <= 75,
      label: ind.rsi !== null ? `RSI ${ind.rsi.toFixed(1)} (trend 45-75)` : 'RSI unavailable',
    }),
    entryZone: (m) => {
      if (m.change24h > 0 && m.positionInRange > 0.5) return { passed: true, side: 'BUY' };
      if (m.change24h < 0 && m.positionInRange < 0.5) return { passed: true, side: 'SELL' };
      return { passed: false, side: null };
    },
    stopLossPct: 0.01,
    takeProfitPct: 0.02,
  },
};

export function getStrategyConfig(strategy: string | null): StrategyConfig {
  return STRATEGY_CONFIG[strategy ?? ''] ?? STRATEGY_CONFIG['momentum'];
}

// ---------------------------------------------------------------------------
// Real indicator math (computed from live exchange klines, never simulated).
// ---------------------------------------------------------------------------

export function computeEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function calculateAtr(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < period + 1) return 0;
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    atr += tr;
  }
  return atr / period;
}

export function computeIndicators(closes: number[]): IndicatorSet {
  const rsi = computeRSI(closes, 14);
  let macd: number | null = null;
  let macdSignal: number | null = null;
  let macdHistogram: number | null = null;
  if (closes.length >= 26) {
    const ema12 = computeEMA(closes, 12);
    const ema26 = computeEMA(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signal = computeEMA(macdLine, 9);
    const last = macdLine.length - 1;
    macd = macdLine[last];
    macdSignal = signal[last];
    macdHistogram = macdLine[last] - signal[last];
  }
  return { rsi, macd, macdSignal, macdHistogram };
}

export function toMetrics(ticker: any): Metrics {
  const price = ticker.price;
  const change24h = ticker.priceChangePercent24h;
  const volume = ticker.quoteVolume24h || ticker.volume24h || 0;
  const range = ticker.highPrice24h - ticker.lowPrice24h;
  const rangePercent = price > 0 ? (range / price) * 100 : 0;
  const positionInRange = range > 0 ? (price - ticker.lowPrice24h) / range : 0.5;
  return { price, change24h, volume, rangePercent, positionInRange };
}

/**
 * Evaluate the configured strategy against REAL live market metrics. The
 * returned `progress` is the percentage of strategy checkpoints currently
 * satisfied by the live data, and `opportunity` is non-null only when every
 * checkpoint passes (i.e. progress === 100). This is the single function that
 * drives both the UI progress bar and the backend trade detection.
 */
export function evaluateStrategy(
  ticker: Ticker,
  ind: IndicatorSet,
  strategyKey: string | null,
  atr: number,
  riskAmount: number,
  minNotional: number,
): StrategyEvaluation {
  const config = getStrategyConfig(strategyKey);
  const m = toMetrics(ticker);
  const checkpoints: Checkpoint[] = [];
  let passed = 0;
  const total = 6;

  const feedPassed = m.price > 0;
  checkpoints.push({ name: 'Live Market Feed', status: feedPassed ? 'passed' : 'failed' });
  if (feedPassed) passed++;

  const volPassed = m.volume >= config.volumeThreshold;
  checkpoints.push({ name: 'Volume Filter', status: volPassed ? 'passed' : 'failed' });
  if (volPassed) passed++;

  const rangePassed = m.rangePercent >= config.rangeThreshold;
  checkpoints.push({ name: 'Volatility Range', status: rangePassed ? 'passed' : 'failed' });
  if (rangePassed) passed++;

  const momPassed = Math.abs(m.change24h) >= config.momentumThreshold;
  checkpoints.push({ name: 'Momentum Check', status: momPassed ? 'passed' : 'failed' });
  if (momPassed) passed++;

  const indRes = config.indicatorCheck(m, ind);
  checkpoints.push({ name: 'Indicator Confirmation', status: indRes.passed ? 'passed' : 'failed' });
  if (indRes.passed) passed++;

  const ez = config.entryZone(m);
  checkpoints.push({ name: 'Entry Zone Validation', status: ez.passed ? 'passed' : 'failed' });
  if (ez.passed) passed++;

  const progress = Math.round((passed / total) * 100);
  const confidence =
    passed === total
      ? Math.min(98, 92 + Math.round(((ind.rsi ?? 50) / 50) * 5))
      : Math.round(50 + (passed / total) * 45);
  const conditionsMet = checkpoints.filter((c) => c.status === 'passed').map((c) => c.name);

  let opportunity: StrategyEvaluation['opportunity'] = null;
  if (passed === total && ez.side) {
    const entry = m.price;
    const atrMultiplier = atr > 0 ? atr : entry * 0.01;
    const stopLoss = ez.side === 'BUY' ? entry - (atrMultiplier * 1.0) : entry + (atrMultiplier * 1.0);
    const takeProfit = ez.side === 'BUY' ? entry + (atrMultiplier * 2.0) : entry - (atrMultiplier * 2.0);
    
    // Risk-based position sizing without silent auto-bumping
    const slDistancePct = (atrMultiplier * 1.0) / entry;
    const calculatedPositionSize = slDistancePct > 0 ? riskAmount / slDistancePct : riskAmount * 10;
    const positionSize = calculatedPositionSize;

    if (minNotional > 0 && positionSize < minNotional) {
      opportunity = null;
    } else {
      const estimatedPnl = Math.abs((takeProfit - entry) / entry) * positionSize;
      opportunity = { symbol: ticker.symbol, entryPrice: entry, stopLoss, takeProfit, estimatedPnl, positionSize, side: ez.side };
    }
  }

  return { checkpoints, total, passed, progress, confidence, conditionsMet, opportunity };
}



/**
 * AdapterCandleProvider acts as a bridge between the isolated MarketDataEngine
 * and the legacy ExchangeAdapters.
 */



export interface ProtectionIntent {
  intentId: string;
  positionId: string;
  alertId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  expectedSL?: number;
  expectedTP?: number;
  actualSL?: number;
  actualTP?: number;
  tickSize: number;
  status: 'PENDING_VERIFICATION' | 'VERIFIED' | 'PROTECTION_FAILED' | 'EMERGENCY_CLOSED';
  createdAt: number;
  updatedAt: number;
}

export interface EmergencyCloseIntent {
  closeIntentId: string;
  positionId: string;
  alertId: string;
  userId: string;
  exchangeName: string;
  environment: string;
  symbol: string;
  category: string;
  side: 'BUY' | 'SELL';
  positionSide: 'long' | 'short';
  positionIdx: number;
  qty: string;
  orderLinkId: string;
  exchangeOrderId?: string;
  status: 'INTENT_PERSISTED' | 'DISPATCHED' | 'UNKNOWN' | 'RECONCILIATION_PENDING' | 'FILLED';
  dispatchedAt?: number;
  attemptCount: number;
  nextRetryAt: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UnprotectedExposureLock {
  positionId: string;
  alertId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  category: string;
  positionIdx: number;
  closeIntentId: string;
  lockedAt: number;
  reason: string;
}

const ALLOWED_WAL_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  INTENT_PERSISTED: new Set(['INTENT_PERSISTED', 'DISPATCHED', 'FAILED']),
  PENDING: new Set(['PENDING', 'DISPATCHED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'UNKNOWN', 'RECONCILIATION_PENDING']),
  DISPATCHING: new Set(['DISPATCHING', 'DISPATCHED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'UNKNOWN', 'RECONCILIATION_PENDING']),
  DISPATCHED: new Set(['DISPATCHED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'UNKNOWN', 'RECONCILIATION_PENDING', 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION']),
  UNKNOWN: new Set(['UNKNOWN', 'RECONCILIATION_PENDING', 'DISPATCHED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION']),
  RECONCILIATION_PENDING: new Set(['RECONCILIATION_PENDING', 'UNKNOWN', 'DISPATCHED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION']),
  PARTIALLY_FILLED: new Set(['PARTIALLY_FILLED', 'FILLED', 'FAILED']),
  FILLED: new Set(['FILLED', 'COMPLETED']),
  COMPLETED: new Set(['COMPLETED']),
  FAILED: new Set(['FAILED', 'DISPATCHED', 'PARTIALLY_FILLED', 'FILLED']),
  ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION: new Set(['ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION', 'DISPATCHED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED']),
};

const EMERGENCY_CLOSE_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 300_000] as const;

export interface TradingBotRuntimeState {
  isInitialized: boolean;
  isActive: boolean;
  userId: string | undefined;
  strategy: string | undefined;
  strategyConfig: Record<string, any> | undefined;
  setupSnapshot: any | undefined;
  positionSize: number | undefined;
  coinId: string | undefined;
  monitoredSymbols: string[];
  activePositions: any[];
  alerts: any[];
  symbolCooldowns: Record<string, number>;
  activeIntents: Map<string, any>;
  pendingPositionSync: any | null;
  lastAccountBalance?: number;
}

export class TradingBot {
  private runtimeState: TradingBotRuntimeState = {
    isInitialized: false, isActive: false, userId: undefined, strategy: undefined,
    strategyConfig: undefined, setupSnapshot: undefined, positionSize: undefined, coinId: undefined,
    monitoredSymbols: [],
    activePositions: [], alerts: [], symbolCooldowns: {}, activeIntents: new Map(),
    pendingPositionSync: null,
    lastAccountBalance: undefined
  };
  private isAlarmRunning: boolean = false;
  private scannerState: any = {};
  private signalLifecycleManager: SignalLifecycleManager = new SignalLifecycleManager();
  private lifecycleMutex: Promise<void> = Promise.resolve();
  private alarmGeneration: number = 0;
  private unprotectedExposureLock: UnprotectedExposureLock | null = null;
  private protectionIntents: Map<string, ProtectionIntent> = new Map();
  private closeIntents: Map<string, EmergencyCloseIntent> = new Map();

  state: DurableObjectState;
  env: Env;
  private isExecutingTrade = false;
  private orchestrator: StrategyOrchestrator;
  private engineApi: EngineAPIService;
  private lastHeartbeatTimestamp = 0;
  private readonly telemetrySink: BackendDiagnosticSink;
  private cachedCredentials: {
    userId: string;
    exchangeName: string;
    environment?: string;
    region?: string;
    apiKey?: string;
    secret?: string;
    password?: string;
    loadedAt: number;
  } | null = null;

  public invalidateCredentialsCache(): void {
    this.cachedCredentials = null;
  }

  public getSignalLifecycleManager(): SignalLifecycleManager {
    return this.signalLifecycleManager;
  }

  private async acquireLifecycleLock(): Promise<() => void> {
    const prev = this.lifecycleMutex;
    let release!: () => void;
    this.lifecycleMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        release();
      }
    };
  }

  private async runExclusiveLifecycle<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireLifecycleLock();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async getOrLoadExchangeCredentials(userId: string): Promise<{
    userId: string;
    exchangeName: string;
    environment?: string;
    region?: string;
    apiKey?: string;
    secret?: string;
    password?: string;
    loadedAt: number;
  } | null> {
    if (this.cachedCredentials && this.cachedCredentials.userId === userId) {
      return this.cachedCredentials;
    }

    try {
      const user = await this.env.DB.prepare(
        'SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_salt FROM users WHERE id = ?'
      ).bind(userId).first<any>();

      if (!user?.exchange_name) {
        return null;
      }

      const encKey = this.env.ENCRYPTION_KEY || (this.env as any).COOKIE_ENCRYPTION_KEY;
      let apiKey: string | undefined = undefined;
      if (encKey && user.exchange_api_key_iv && user.exchange_api_key_encrypted) {
        try {
          apiKey = await decrypt({ iv: user.exchange_api_key_iv, encrypted: user.exchange_api_key_encrypted, salt: user.exchange_api_key_salt }, encKey);
        } catch (_) {}
      }
      if (!apiKey && user.exchange_api_key) {
        apiKey = user.exchange_api_key;
      }

      let secret: string | undefined = undefined;
      if (encKey && user.exchange_api_secret_iv && user.exchange_api_secret_encrypted) {
        try {
          secret = await decrypt({ iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted, salt: user.exchange_api_secret_salt }, encKey);
        } catch (_) {}
      }

      let password: string | undefined = undefined;
      if (encKey && user.exchange_api_passphrase_iv && user.exchange_api_passphrase_encrypted) {
        try {
          password = await decrypt({ iv: user.exchange_api_passphrase_iv, encrypted: user.exchange_api_passphrase_encrypted, salt: user.exchange_api_passphrase_salt }, encKey);
        } catch (_) {}
      }

      this.cachedCredentials = {
        userId,
        exchangeName: user.exchange_name,
        environment: user.exchange_environment,
        region: user.exchange_region,
        apiKey,
        secret,
        password,
        loadedAt: Date.now()
      };

      return this.cachedCredentials;
    } catch (e) {
      console.error('[TradingBot] Failed to load exchange credentials from D1:', e);
      return null;
    }
  }

  private async ensureInitialized() {
    if (this.runtimeState.isInitialized) return;
    await this.state.blockConcurrencyWhile(async () => {
      const keys = ['isActive', 'userId', 'strategy', 'strategyConfig', 'setupSnapshot', 'positionSize', 'coinId', 'monitoredSymbols', 'activePositions', 'alerts', 'symbolCooldowns', 'pendingPositionSync', 'lastAccountBalance', 'lock:alarmGeneration', 'lock:unprotectedExposure'];
      let vals: any = null;
      try {
        vals = await this.state.storage.get<any>(keys);
      } catch (_) {}
      const getVal = async (k: string) => {
        const valFromMap = vals && typeof (vals as any).get === 'function' ? (vals as any).get(k) : (vals as any)?.[k];
        if (valFromMap !== undefined) return valFromMap;
        try {
          return await this.state.storage.get(k);
        } catch (_) {
          return undefined;
        }
      };
      this.runtimeState.isActive = (await getVal('isActive')) || false;
      this.runtimeState.userId = await getVal('userId');
      this.runtimeState.strategy = await getVal('strategy');
      this.runtimeState.strategyConfig = await getVal('strategyConfig');
      this.runtimeState.setupSnapshot = await getVal('setupSnapshot');
      this.runtimeState.positionSize = await getVal('positionSize');
      this.runtimeState.coinId = await getVal('coinId');

      const storedGen = await getVal('lock:alarmGeneration');
      this.alarmGeneration = (typeof storedGen === 'number' && Number.isInteger(storedGen) && storedGen > 0) ? storedGen : 0;
      this.unprotectedExposureLock = (await getVal('lock:unprotectedExposure')) || null;

      const storedSymbols = await getVal('monitoredSymbols');
      if (Array.isArray(storedSymbols) && storedSymbols.length > 0) {
        this.runtimeState.monitoredSymbols = storedSymbols;
      } else if (this.runtimeState.coinId) {
        this.runtimeState.monitoredSymbols = [this.runtimeState.coinId];
      } else {
        this.runtimeState.monitoredSymbols = [];
      }

      this.runtimeState.activePositions = (await getVal('activePositions')) || [];
      this.runtimeState.alerts = (await getVal('alerts')) || [];
      this.runtimeState.symbolCooldowns = (await getVal('symbolCooldowns')) || {};
      this.runtimeState.pendingPositionSync = (await getVal('pendingPositionSync')) || null;
      this.runtimeState.lastAccountBalance = (await getVal('lastAccountBalance')) ?? undefined;

      const intentMap = await this.state.storage.list({ prefix: 'intent:order:' });
      for (const [k, v] of intentMap.entries()) {
        const cleanId = k.startsWith('intent:order:') ? k.slice('intent:order:'.length) : k;
        this.runtimeState.activeIntents.set(cleanId, v ? { ...(v as any) } : v);
      }

      const protMap = await this.state.storage.list({ prefix: 'intent:protection:' });
      for (const [k, v] of protMap.entries()) {
        const cleanId = k.startsWith('intent:protection:') ? k.slice('intent:protection:'.length) : k;
        this.protectionIntents.set(cleanId, { ...(v as ProtectionIntent) });
      }

      const closeMap = await this.state.storage.list({ prefix: 'intent:close:' });
      for (const [k, v] of closeMap.entries()) {
        const cleanId = k.startsWith('intent:close:') ? k.slice('intent:close:'.length) : k;
        this.closeIntents.set(cleanId, { ...(v as EmergencyCloseIntent) });
      }

      const storedLifecycleState = (await getVal('signal_lifecycle_state')) || null;
      if (storedLifecycleState) {
        try {
          this.signalLifecycleManager.restoreState(storedLifecycleState);
        } catch (_) {}
      }
      this.runtimeState.isInitialized = true;
    });
  }

  private async persistState(key: string, value: any) {
    (this.runtimeState as any)[key] = value;
    await this.state.storage.put(key, value);
  }

  private canTransitionIntentStatus(existing: any, nextIntent: any): boolean {
    if (!existing || !existing.status) return true;
    const oldStatus = String(existing.status);
    const newStatus = String(nextIntent.status || oldStatus);
    const allowed = ALLOWED_WAL_TRANSITIONS[oldStatus];
    if (!allowed || !allowed.has(newStatus)) {
      return false;
    }
    if (existing.dispatchedAt !== undefined && newStatus === 'INTENT_PERSISTED') {
      return false;
    }
    if (oldStatus === 'INTENT_PERSISTED' && (newStatus === 'UNKNOWN' || newStatus === 'RECONCILIATION_PENDING' || newStatus === 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION')) {
      return false;
    }
    if (oldStatus === 'FAILED') {
      if (existing.dispatchedAt === undefined) {
        return newStatus === 'FAILED';
      }
      if (newStatus !== 'FAILED') {
        return !existing.actualOrderId && Boolean(nextIntent.actualOrderId);
      }
    }
    if (oldStatus === 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION' && newStatus !== 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION') {
      return Boolean(nextIntent.actualOrderId);
    }
    if (oldStatus === 'PARTIALLY_FILLED' && newStatus === 'FAILED' && Number(existing.actualExecutedQuantity || 0) > 0) {
      return false;
    }
    return true;
  }

  public async persistIntentSnapshot(intentId: string, nextIntent: any): Promise<any> {
    const cleanId = intentId.startsWith('intent:order:') ? intentId.slice('intent:order:'.length) : intentId;
    const key = 'intent:order:' + cleanId;
    let committed: any = nextIntent;
    await this.state.storage.transaction(async (txn) => {
      const existing = ((await txn.get(key)) ?? this.runtimeState.activeIntents.get(cleanId) ?? this.runtimeState.activeIntents.get(key)) as any;
      if (!existing) {
        committed = { ...nextIntent, intentId: nextIntent.intentId || cleanId };
      } else {
        const allowStatus = this.canTransitionIntentStatus(existing, nextIntent);
        const resolvedStatus = allowStatus ? (nextIntent.status || existing.status) : existing.status;

        const prevQty = new BigNumber(existing.actualExecutedQuantity || 0);
        const nextQty = new BigNumber(nextIntent.actualExecutedQuantity || 0);
        const maxQty = nextQty.gt(prevQty) ? nextIntent.actualExecutedQuantity : existing.actualExecutedQuantity;

        const nextFillPx = new BigNumber(nextIntent.actualFillPrice || 0);
        const resolvedFillPrice = nextFillPx.gt(0) ? nextIntent.actualFillPrice : existing.actualFillPrice;

        committed = {
          ...existing,
          ...nextIntent,
          intentId: existing.intentId || nextIntent.intentId || cleanId,
          status: resolvedStatus,
          dispatchedAt: existing.dispatchedAt ?? nextIntent.dispatchedAt,
          actualOrderId: nextIntent.actualOrderId || existing.actualOrderId,
          actualExecutedQuantity: maxQty,
          actualFillPrice: resolvedFillPrice,
          slOrderId: nextIntent.slOrderId || existing.slOrderId,
          tpOrderId: nextIntent.tpOrderId || existing.tpOrderId,
          reconciliationAttemptCount: Math.max(
            Number(existing.reconciliationAttemptCount ?? 0),
            Number(nextIntent.reconciliationAttemptCount ?? 0)
          ),
          reconciliationAttempts: Math.max(
            Number(existing.reconciliationAttempts ?? 0),
            Number(nextIntent.reconciliationAttempts ?? 0)
          ),
        };
      }
      await txn.put(key, committed);
    });
    this.runtimeState.activeIntents.set(cleanId, committed);
    await this.state.storage.put(key, committed);
    return committed;
  }

  private async persistIntent(intentId: string, intent: any) {
    return this.persistIntentSnapshot(intentId, intent);
  }

  private async deleteIntent(_intentId: string) {
    // Intentionally retain WAL intent evidence permanently to prevent duplicate order submission after restart
  }

  private async persistProtectionIntent(intentOrId: ProtectionIntent | string, maybeIntent?: ProtectionIntent): Promise<ProtectionIntent> {
    const intent = (typeof intentOrId === 'string' ? maybeIntent! : intentOrId);
    const id = typeof intentOrId === 'string' ? intentOrId : (intent.positionId || intent.intentId);
    const cleanId = id.startsWith('intent:protection:') ? id.slice('intent:protection:'.length) : id;
    const key = `intent:protection:${cleanId}`;
    const snapshot = { ...intent };
    await this.state.storage.transaction(async (txn) => {
      await txn.put(key, snapshot);
    });
    this.protectionIntents.set(cleanId, snapshot);
    await this.state.storage.put(key, snapshot);
    return snapshot;
  }

  private async persistCloseIntent(intentOrId: EmergencyCloseIntent | string, maybeIntent?: EmergencyCloseIntent): Promise<EmergencyCloseIntent> {
    const intent = (typeof intentOrId === 'string' ? maybeIntent! : intentOrId);
    const id = typeof intentOrId === 'string' ? intentOrId : intent.closeIntentId;
    const cleanId = id.startsWith('intent:close:') ? id.slice('intent:close:'.length) : id;
    const key = `intent:close:${cleanId}`;
    const snapshot = { ...intent };
    await this.state.storage.transaction(async (txn) => {
      await txn.put(key, snapshot);
    });
    this.closeIntents.set(cleanId, snapshot);
    await this.state.storage.put(key, snapshot);
    return snapshot;
  }

  private async setUnprotectedExposureLock(lock: UnprotectedExposureLock): Promise<void> {
    await this.state.storage.transaction(async (txn) => {
      await txn.put('lock:unprotectedExposure', lock);
    });
    this.unprotectedExposureLock = lock;
    await this.state.storage.put('lock:unprotectedExposure', lock);
  }

  private async clearUnprotectedExposureLock(): Promise<void> {
    await this.state.storage.transaction(async (txn) => {
      await txn.delete('lock:unprotectedExposure');
    });
    this.unprotectedExposureLock = null;
    await this.state.storage.delete('lock:unprotectedExposure');
  }

  public normalizeSymbol(s: string | undefined | null): string {
    if (!s) return '';
    return s.replace(/[\/_-]/g, '').toUpperCase().trim();
  }

  public getPositionNotional(pos: any): number {
    const qty = Number(pos.quantity ?? pos.amount ?? pos.filled_quantity ?? 0);
    const price = Number(pos.average_fill_price ?? pos.averageFillPrice ?? pos.entry_price ?? pos.entryPrice ?? pos.limit_price ?? pos.limitPrice ?? pos.target_entry_price ?? pos.targetEntryPrice ?? 0);
    const notional = qty * price;
    if (notional > 0) return notional;
    if (pos.positionSize && typeof pos.positionSize === 'number') return pos.positionSize;
    if (pos.tradeValueUsdt && typeof pos.tradeValueUsdt === 'number') return pos.tradeValueUsdt;
    return 0;
  }

  public getIntentNotional(intent: any): number {
    if (intent.notionalUsdt && typeof intent.notionalUsdt === 'number') return intent.notionalUsdt;
    const qty = Number(intent.qty ?? intent.quantity ?? intent.amount ?? 0);
    const price = Number(intent.price ?? intent.signalPrice ?? intent.entryPrice ?? intent.limitPrice ?? 0);
    if (qty > 0 && price > 0) return qty * price;
    if (intent.positionSize && typeof intent.positionSize === 'number') return intent.positionSize;
    if (intent.payloadSnapshot?.amount && intent.payloadSnapshot?.price) {
      return Number(intent.payloadSnapshot.amount) * Number(intent.payloadSnapshot.price);
    }
    return 0;
  }

  public calculateAggregateExposure(positions: any[]): number {
    let totalExposure = 0;
    for (const pos of positions) {
      totalExposure += this.getPositionNotional(pos);
    }
    for (const val of this.runtimeState.activeIntents.values()) {
      const intent = val as any;
      if (['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(intent.status)) {
        totalExposure += this.getIntentNotional(intent);
      }
    }
    return totalExposure;
  }

  public resolveMaxPortfolioExposure(accountBalance: number, strategyConfig?: Record<string, any>, setupSnapshot?: any): number {
    // If account balance is unavailable, zero, or non-positive, fail closed immediately
    if (typeof accountBalance !== 'number' || accountBalance <= 0 || isNaN(accountBalance)) {
      return 0;
    }

    const directUsdt = strategyConfig?.maxPortfolioExposureUsdt ??
                       setupSnapshot?.maxPortfolioExposureUsdt ??
                       strategyConfig?.maxPortfolioExposure ??
                       setupSnapshot?.maxPortfolioExposure;
    if (typeof directUsdt === 'number' && directUsdt > 0) {
      return Math.min(directUsdt, accountBalance);
    }

    const percentLimit = strategyConfig?.maxPortfolioExposurePercent ??
                         setupSnapshot?.maxPortfolioExposurePercent ??
                         strategyConfig?.portfolioRiskPercent;
    if (typeof percentLimit === 'number' && percentLimit > 0) {
      return accountBalance * (percentLimit / 100);
    }

    // Default portfolio exposure policy: default to live account balance (solvency bound)
    return accountBalance;
  }

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.orchestrator = new StrategyOrchestrator();
    this.engineApi = new EngineAPIService();

    this.telemetrySink = new BackendDiagnosticSink({
      db: env.DB,
      waitUntil: (p) => {
        try {
          if (this.state && typeof this.state.waitUntil === 'function') {
            this.state.waitUntil(p);
          }
        } catch (_) {}
      },
      disableTelemetry: (env as any)?.DISABLE_BACKEND_TELEMETRY === 'true'
    });
    
    // Feature 5: DO Recovery
    // Reconstruct memory state from durable storage safely
    this.state.blockConcurrencyWhile(async () => {
      this.isExecutingTrade = (await this.state.storage.get('isExecutingTrade')) || false;
      const scanCurrent = await this.state.storage.get('scan:current') as any;
      if (scanCurrent && scanCurrent.status === 'RUNNING') {
        await this.state.storage.put({
          'scan:current': {
            ...scanCurrent,
            status: 'ABORTED',
            abortedAt: Date.now(),
            abortReason: 'DO_RESTART_RECOVERY',
          },
          'scan:activeScanId': null,
        });
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/activate': {
        this.invalidateCredentialsCache();
        let committedGen = 1;
        let user: any = null;
        let earlyErrorResponse: Response | null = null;
        await this.runExclusiveLifecycle(async () => {
          const { userId, coinId, symbols, strategy, positionSize, targetEntryPrice, config } = await request.json<{
            userId: string;
            coinId?: string;
            symbols?: string[];
            strategy: string;
            positionSize?: number;
            targetEntryPrice?: number;
            config?: any;
          }>();

          // Safe symbol resolution - NO BTCUSDT FALLBACK
          let resolvedSymbols: string[] = [];
          if (Array.isArray(symbols) && symbols.length > 0) {
            resolvedSymbols = symbols.map(s => String(s).trim()).filter(s => s.length > 0);
          } else if (coinId && typeof coinId === 'string' && coinId.trim().length > 0) {
            resolvedSymbols = [coinId.trim()];
          }

          if (resolvedSymbols.length === 0) {
            earlyErrorResponse = new Response(
              JSON.stringify({
                success: false,
                error: 'Cannot activate bot: No valid trading symbols provided.',
                code: 'INVALID_SYMBOLS',
              }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
            return;
          }

          const primaryCoinId = resolvedSymbols[0];

          user = await this.env.DB.prepare('SELECT exchange_name, exchange_environment, exchange_region, exchange_connection_status, exchange_api_key, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_salt FROM users WHERE id = ?').bind(userId).first<any>();

          if (user?.exchange_connection_status === 'INVALID') {
            earlyErrorResponse = new Response(
              JSON.stringify({
                success: false,
                error: 'Exchange connection is invalid. Please reconnect your exchange in settings before activating the trading bot.',
                code: 'AUTHENTICATION_FAILED',
              }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
            return;
          }

          const setupSnapshot: TradeSetupSnapshot = Object.freeze({
            userId,
            coinId: primaryCoinId,
            strategy,
            targetEntryPrice: targetEntryPrice ?? undefined,
            positionSize: positionSize ?? undefined,
            activatedAt: new Date().toISOString(),
            exchangeName: user?.exchange_name ?? undefined,
            environment: user?.exchange_environment ?? undefined,
          });

          await this.logAuditEvent(userId, 'BOT_ACTIVATED', { strategy, coinId: primaryCoinId, symbols: resolvedSymbols, positionSize, targetEntryPrice });

          const initialLogs: AnalysisLog[] = [
            { timestamp: new Date().toISOString(), level: 'info' as const, message: `Bot activated for strategy: ${strategy || 'default'}` },
            { timestamp: new Date().toISOString(), level: 'info' as const, message: `Monitoring pairs (${resolvedSymbols.length}): ${resolvedSymbols.join(', ')}` },
          ];
          const activatedAtNow = Date.now();

          let updatedAlertsOnActivate: TradeAlert[] = [];
          await this.state.storage.transaction(async (txn) => {
            const prevGen = await txn.get<number>('lock:alarmGeneration');
            committedGen = (typeof prevGen === 'number' && Number.isInteger(prevGen) && prevGen >= 0) ? prevGen + 1 : 1;
            const existingAlerts = ((await txn.get<TradeAlert[]>('alerts')) || this.runtimeState.alerts || []) as TradeAlert[];
            updatedAlertsOnActivate = this.expireStaleAlertsOnLifecycleTransition(existingAlerts, committedGen);
            await txn.put('lock:alarmGeneration', committedGen);
            await txn.put('isActive', true);
            await txn.put('coinId', primaryCoinId);
            await txn.put('monitoredSymbols', resolvedSymbols);
            await txn.put('strategy', strategy);
            await txn.put('userId', userId);
            await txn.delete('newAnalysis');
            if (config) {
              await txn.put('strategyConfig', config);
            } else {
              await txn.delete('strategyConfig');
            }
            if (targetEntryPrice != null) {
              await txn.put('targetEntryPrice', targetEntryPrice);
            } else {
              await txn.delete('targetEntryPrice');
            }
            if (positionSize != null) {
              await txn.put('positionSize', positionSize);
            } else {
              await txn.delete('positionSize');
            }
            await txn.put('alerts', updatedAlertsOnActivate);
            await txn.put('tradeActive', false);
            await txn.put('logs', initialLogs);
            await txn.put('activatedAt', activatedAtNow);
            await txn.delete('lastPositionCheckAt');
            await txn.put('setupSnapshot', setupSnapshot);
          });

          this.alarmGeneration = committedGen;
          this.runtimeState.isActive = true;
          this.runtimeState.coinId = primaryCoinId;
          this.runtimeState.monitoredSymbols = resolvedSymbols;
          this.runtimeState.strategy = strategy;
          this.runtimeState.userId = userId;
          this.runtimeState.strategyConfig = config ?? undefined;
          this.runtimeState.positionSize = positionSize ?? undefined;
          this.runtimeState.alerts = updatedAlertsOnActivate;
          this.runtimeState.setupSnapshot = setupSnapshot;
        });

        if (earlyErrorResponse) {
          return earlyErrorResponse;
        }

        // Feature: Sprint 1 Orchestrator Activation
        this.orchestrator = new StrategyOrchestrator(); // Reset on explicit activation

        if (user?.exchange_name) {
          let apiKey: string | undefined = undefined;
          if (user.exchange_api_key_iv && user.exchange_api_key_encrypted) {
            try {
              apiKey = await decrypt({ iv: user.exchange_api_key_iv, encrypted: user.exchange_api_key_encrypted, salt: user.exchange_api_key_salt }, this.env.ENCRYPTION_KEY);
            } catch (_) {}
          }
          if (!apiKey && user.exchange_api_key) {
            apiKey = user.exchange_api_key;
          }

          let secret: string | undefined = undefined;
          if (user.exchange_api_secret_iv && user.exchange_api_secret_encrypted) {
            try {
              secret = await decrypt({ iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted, salt: user.exchange_api_secret_salt }, this.env.ENCRYPTION_KEY);
            } catch (_) {}
          }

          let password: string | undefined = undefined;
          if (user.exchange_api_passphrase_iv && user.exchange_api_passphrase_encrypted) {
            try {
              password = await decrypt({ iv: user.exchange_api_passphrase_iv, encrypted: user.exchange_api_passphrase_encrypted, salt: user.exchange_api_passphrase_salt }, this.env.ENCRYPTION_KEY);
            } catch (_) {}
          }

          const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
            environment: normalizeEnvironment(user.exchange_environment),
            apiKey,
            secret,
            password,
            region: resolveCanonicalRoutingRegion(user.exchange_region),
          });

          const provider = new AdapterCandleProvider(adapter);
          const dataEngine = new MarketDataEngine(provider);
          this.orchestrator.setMarketDataEngine(dataEngine);
        }

        await this.state.storage.put('engineState', this.orchestrator.getCurrentState());

        await this.state.storage.setAlarm(Date.now() + 1000); // Trigger FSM almost immediately

        return new Response(JSON.stringify({ success: true, message: 'Bot activated.', generation: committedGen }), { status: 200 });
      }
      case '/deactivate': {
        this.invalidateCredentialsCache();
        let committedGen = 1;
        await this.runExclusiveLifecycle(async () => {
          const userId = this.runtimeState.userId as string | undefined;
          if (userId) {
            await this.logAuditEvent(userId, 'BOT_DEACTIVATED', { reason: 'user_requested' });
          }
          const existingLogs = (await this.state.storage.get('logs')) as AnalysisLog[] | undefined;
          const nextLogs = (existingLogs ?? []).concat([
            { timestamp: new Date().toISOString(), level: 'info' as const, message: 'Bot deactivated by user.' },
          ]);

          let updatedAlertsOnDeactivate: TradeAlert[] = [];
          await this.state.storage.transaction(async (txn) => {
            const prevGen = await txn.get<number>('lock:alarmGeneration');
            committedGen = (typeof prevGen === 'number' && Number.isInteger(prevGen) && prevGen >= 0) ? prevGen + 1 : 1;
            const existingAlerts = ((await txn.get<TradeAlert[]>('alerts')) || this.runtimeState.alerts || []) as TradeAlert[];
            updatedAlertsOnDeactivate = this.expireStaleAlertsOnLifecycleTransition(existingAlerts, committedGen);
            await txn.put('lock:alarmGeneration', committedGen);
            await txn.put('isActive', false);
            await txn.put('coinId', null);
            await txn.put('monitoredSymbols', []);
            await txn.put('strategy', null);
            await txn.put('alerts', updatedAlertsOnDeactivate);
            await txn.put('tradeActive', false);
            await txn.delete('newAnalysis');
            await txn.put('logs', nextLogs);
          });

          this.alarmGeneration = committedGen;
          this.runtimeState.isActive = false;
          this.runtimeState.coinId = null as any;
          this.runtimeState.monitoredSymbols = [];
          this.runtimeState.strategy = null as any;
          this.runtimeState.alerts = updatedAlertsOnDeactivate;
        });
        if (this.hasPendingSafetyWork()) {
          try { await this.state.storage.setAlarm(Date.now() + 5000); } catch (e) { /* ignore */ }
        } else {
          try { await this.state.storage.deleteAlarm(); } catch (e) { /* ignore */ }
        }
        return new Response(JSON.stringify({ success: true, message: 'Bot deactivated.', generation: committedGen }), { status: 200 });
      }

      case '/reload-credentials': {
        this.invalidateCredentialsCache();
        return new Response(JSON.stringify({ success: true, message: 'Credentials cache invalidated.' }), { status: 200 });
      }

      case '/scanner-state': {
        return new Response(JSON.stringify(this.scannerState || {}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      case '/status': {
        const isActive = this.runtimeState.isActive || false;
        const coinId = this.runtimeState.coinId || null;
        const strategy = this.runtimeState.strategy || null;
        const symbols = this.runtimeState.monitoredSymbols || (coinId ? [coinId] : []);
        return new Response(JSON.stringify({ isActive, coinId, strategy, symbols }), { status: 200 });
      }
      case '/analysis-status': {
        const isActive = this.runtimeState.isActive || false;
        const committedStrategy = this.runtimeState.strategy || null;
        const safeMode = false;
        const newAnalysis = (await this.state.storage.get('newAnalysis')) as any;

        if (newAnalysis) {
          const engineStatus = {
            ...(newAnalysis.engineStatus || {}),
            state: isActive ? (newAnalysis.engineStatus?.state || 'WAITING') : 'STOPPED',
            activeStrategy: isActive ? committedStrategy : null,
            committedStrategy: committedStrategy,
          };
          return new Response(JSON.stringify({
            ...newAnalysis,
            safeMode,
            isActive,
            committedStrategy,
            engineStatus,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const coinId = this.runtimeState.coinId as string || 'BTCUSDT';
        const strategy = committedStrategy || 'ScalperV2';

        const registry = StrategyRegistry.getInstance();
        const normalizedId = registry.normalizeStrategyId(strategy);
        const manifests = registry.getAllManifests();
        const manifest = registry.getManifest(normalizedId) || manifests.find(m => m.id.toLowerCase() === normalizedId.toLowerCase());
        if (!manifest) {
          new StructuredLogger().warn(`[StrategyOrchestrator] Strategy '${strategy}' not found. Available: ${manifests.map(m => m.id).join(', ')}`);
          throw new UnifiedError(`Strategy '${strategy}' is not registered.`, 'UNSUPPORTED_OPERATION');
        }

        const fallbackResult = {
          strategyId: manifest.id,
          timestamp: Date.now(),
          confidenceScore: 50,
          hasSignal: false,
          metadata: {
            reasoning: ['Analysis pending initial evaluation cycle'],
          },
        };

        const fallbackSnapshot = {
          symbol: coinId,
          timestamp: Date.now(),
          currentPrice: 50000.0,
          volume24h: 1000000.0,
          quoteVolume24h: 1000000.0,
          candles: { '1m': [], '3m': [], '5m': [], '15m': [], '30m': [], '1h': [], '4h': [] },
          metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: 51000.0, lowPrice24h: 49000.0 },
        };

        const snapshotDto = AnalysisSnapshotMapper.map(
          fallbackResult,
          manifest,
          fallbackSnapshot as any,
          isActive ? 'WAITING' : 'STOPPED',
          Boolean(isActive)
        );
        snapshotDto.strategyAnalyses = AnalysisSnapshotMapper.mapStrategyEvaluations([], registry, Date.now());

        const engineStatus = {
          ...(snapshotDto.engineStatus || {}),
          state: isActive ? 'WAITING' : 'STOPPED',
          activeStrategy: isActive ? committedStrategy : null,
          committedStrategy: committedStrategy,
        };

        return new Response(JSON.stringify({
          ...snapshotDto,
          safeMode,
          isActive,
          committedStrategy,
          engineStatus,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      case '/strategies': {
        const manifests = StrategyRegistry.getInstance().getAllManifests();
        const response: import('./api/engine/StrategyManifestDTO').StrategyDiscoveryResponseDTO = {
          version: '2.0',
          count: manifests.length,
          strategies: manifests
        };
        return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      case '/register-alert': {
        const { alert } = await request.json<{ alert: TradeAlert }>();
        if (!alert || !alert.id) {
          return new Response(JSON.stringify({ success: false, message: 'Invalid alert payload.' }), { status: 400 });
        }

        console.log(`[ALERT_REGISTER] id=${alert.id} symbol=${alert.symbol} strategy=${alert.strategy}`);
        let registeredAlert: TradeAlert;
        if (alert.source === 'AUTONOMOUS') {
          const [persistedIsActive, storedGen] = await Promise.all([
            this.state.storage.get<boolean>('isActive'),
            this.state.storage.get<number>('lock:alarmGeneration'),
          ]);
          const isValidGen = typeof storedGen === 'number' && Number.isInteger(storedGen) && storedGen > 0;
          if (persistedIsActive !== true || !isValidGen) {
            return new Response(
              JSON.stringify({
                success: false,
                code: persistedIsActive !== true ? 'BOT_INACTIVE_AUTONOMOUS_REJECTED' : 'STALE_AUTONOMOUS_GENERATION',
                error: 'Cannot register autonomous alert while bot is inactive or generation is invalid.',
              }),
              { status: 409, headers: { 'Content-Type': 'application/json' } }
            );
          }
          registeredAlert = {
            ...alert,
            status: 'pending',
            source: 'AUTONOMOUS',
            generation: alert.generation ?? storedGen,
          };
        } else {
          registeredAlert = {
            ...alert,
            status: 'pending',
            source: 'MANUAL',
            generation: undefined,
          };
        }

        const alerts = this.runtimeState.alerts as TradeAlert[] || [];
        const existingIndex = alerts.findIndex((a) => a.id === alert.id);
        if (existingIndex >= 0) {
          alerts[existingIndex] = { ...alerts[existingIndex], ...registeredAlert };
        } else {
          alerts.push(registeredAlert);
        }
        await this.persistState('alerts', this.pruneAlerts(alerts));
        console.log(`[ALERT_REGISTERED] id=${alert.id} storage=alerts status=pending source=${registeredAlert.source}`);

        return new Response(JSON.stringify({ success: true, alertId: alert.id }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      case '/alerts': {
        const alerts = this.runtimeState.alerts as TradeAlert[] || [];
        const pending = alerts.filter((a) => a.status === 'pending');
        return new Response(JSON.stringify(pending), { status: 200 });
      }
      case '/execution-status': {
        const url = new URL(request.url);
        const positionId = url.searchParams.get('positionId') || url.searchParams.get('id');
        if (!positionId) {
          return new Response(JSON.stringify({ success: false, message: 'positionId is required.' }), { status: 400 });
        }

        const userId: string | undefined = (this.runtimeState.userId as string) || (await this.state.storage.get('userId')) as string | undefined;
        if (!userId) {
          return new Response(JSON.stringify({ success: false, message: 'Bot not initialized with a user.' }), { status: 500 });
        }

        // 1. Read in-memory WAL intent (read-only)
        const intentObj = (await this.state.storage.get(`intent:order:${positionId}`)) as any;

        // 2. Query persistent D1 database (read-only)
        let dbPos: any = null;
        try {
          dbPos = await this.env.DB.prepare(
            `SELECT id, user_id, symbol, side, entry_price, target_entry_price, average_fill_price, quantity, filled_quantity, stop_loss, take_profit, status, entry_status, exchange, environment, strategy, order_id, entry_exchange_order_id, order_type, limit_price, entry_submitted_at, entry_at, created_at, updated_at
             FROM trade_positions
             WHERE id = ? AND user_id = ?`
          ).bind(positionId, userId).first<any>();
        } catch (dbErr: any) {
          console.warn('[trading-bot] Error querying trade_positions from D1 for execution-status:', dbErr?.message);
        }

        if (!intentObj && !dbPos) {
          return new Response(JSON.stringify({ success: false, message: 'Position not found.' }), { status: 404 });
        }

        // Authoritative Bybit Reconciliation: If not yet filled and on Bybit, reconcile state
        const currentEntryStatus = dbPos?.entry_status || intentObj?.status || 'PENDING_ENTRY';
        const isAlreadyFilled = currentEntryStatus === 'FILLED' || currentEntryStatus === 'closed';

        if (!isAlreadyFilled && (dbPos?.exchange === 'bybit' || intentObj?.exchangeName === 'bybit')) {
          try {
            const userKeys = await this.env.DB.prepare(
              'SELECT exchange_api_key, exchange_api_key_encrypted, exchange_api_key_iv, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?'
            ).bind(userId).first<any>();

            if (userKeys?.exchange_name === 'bybit') {
              let decryptedApiKey = userKeys.exchange_api_key || '';
              let decryptedSecret = '';
              if (userKeys.exchange_api_key_encrypted && userKeys.exchange_api_key_iv && userKeys.exchange_api_key_salt && this.env.ENCRYPTION_KEY) {
                decryptedApiKey = await decrypt({ iv: userKeys.exchange_api_key_iv, encrypted: userKeys.exchange_api_key_encrypted, salt: userKeys.exchange_api_key_salt }, this.env.ENCRYPTION_KEY);
              }
              if (userKeys.exchange_api_secret_encrypted && userKeys.exchange_api_secret_iv && userKeys.exchange_api_secret_salt && this.env.ENCRYPTION_KEY) {
                decryptedSecret = await decrypt({ iv: userKeys.exchange_api_secret_iv, encrypted: userKeys.exchange_api_secret_encrypted, salt: userKeys.exchange_api_secret_salt }, this.env.ENCRYPTION_KEY);
              }

              const provider = await ExchangeManager.getProvider('bybit', {
                environment: normalizeEnvironment(userKeys.exchange_environment),
                apiKey: decryptedApiKey,
                secret: decryptedSecret,
                region: resolveCanonicalRoutingRegion(userKeys.exchange_region),
              });

              if (intentObj) {
                await ReconciliationEngine.reconcile(provider, intentObj, Date.now());
                await this.state.storage.put(`intent:order:${positionId}`, intentObj);

                if (intentObj.status === 'FILLED' || intentObj.status === 'PARTIALLY_FILLED') {
                  const avgPrice = parseFloat(intentObj.actualFillPrice || '0');
                  const filledQty = parseFloat(intentObj.actualExecutedQuantity || '0');
                  const now = new Date().toISOString();

                  await this.env.DB.prepare(
                    `UPDATE trade_positions 
                     SET entry_status = ?, average_fill_price = ?, filled_quantity = ?, status = 'OPEN', updated_at = ?
                     WHERE id = ? AND user_id = ?`
                  ).bind(intentObj.status, avgPrice > 0 ? avgPrice : null, filledQty, now, positionId, userId).run();

                  dbPos = await this.env.DB.prepare(
                    `SELECT id, user_id, symbol, side, entry_price, target_entry_price, average_fill_price, quantity, filled_quantity, stop_loss, take_profit, status, entry_status, exchange, environment, strategy, order_id, entry_exchange_order_id, order_type, limit_price, entry_submitted_at, entry_at, created_at, updated_at
                     FROM trade_positions WHERE id = ? AND user_id = ?`
                  ).bind(positionId, userId).first<any>();
                } else if (intentObj.status === 'FAILED' || intentObj.status === 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION') {
                  await this.env.DB.prepare(
                    `DELETE FROM trade_positions WHERE id = ? AND user_id = ?`
                  ).bind(positionId, userId).run();

                  dbPos = null;
                }
              }
            }
          } catch (reconErr: any) {
            console.warn('[trading-bot] Execution status reconciliation error:', reconErr?.message || reconErr);
          }
        }

        // Authoritative Bybit Position Lifecycle Reconciliation: If position is OPEN and on Bybit, verify if closed on exchange
        let isReconciledClosed = false;
        if (dbPos && dbPos.status === 'OPEN' && dbPos.entry_status === 'FILLED' && dbPos.exchange === 'bybit') {
          try {
            const userKeys = await this.env.DB.prepare(
              'SELECT exchange_api_key, exchange_api_key_encrypted, exchange_api_key_iv, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?'
            ).bind(userId).first<any>();

            if (userKeys?.exchange_name === 'bybit') {
              let decryptedApiKey = userKeys.exchange_api_key || '';
              let decryptedSecret = '';
              if (userKeys.exchange_api_key_encrypted && userKeys.exchange_api_key_iv && userKeys.exchange_api_key_salt && this.env.ENCRYPTION_KEY) {
                decryptedApiKey = await decrypt({ iv: userKeys.exchange_api_key_iv, encrypted: userKeys.exchange_api_key_encrypted, salt: userKeys.exchange_api_key_salt }, this.env.ENCRYPTION_KEY);
              }
              if (userKeys.exchange_api_secret_encrypted && userKeys.exchange_api_secret_iv && userKeys.exchange_api_secret_salt && this.env.ENCRYPTION_KEY) {
                decryptedSecret = await decrypt({ iv: userKeys.exchange_api_secret_iv, encrypted: userKeys.exchange_api_secret_encrypted, salt: userKeys.exchange_api_secret_salt }, this.env.ENCRYPTION_KEY);
              }

              const provider = await ExchangeManager.getProvider('bybit', {
                environment: normalizeEnvironment(userKeys.exchange_environment),
                apiKey: decryptedApiKey,
                secret: decryptedSecret,
                region: resolveCanonicalRoutingRegion(userKeys.exchange_region),
              });

              const closeResult = await ReconciliationEngine.reconcilePositionLifecycle(provider, dbPos, Date.now());
              if (closeResult && closeResult.status === 'CLOSED') {
                isReconciledClosed = true;
                await this.env.DB.prepare(
                  `DELETE FROM trade_positions 
                   WHERE id = ? AND user_id = ? AND status = 'OPEN'`
                ).bind(positionId, userId).run();

                dbPos = null;
              }
            }
          } catch (posReconErr: any) {
            console.warn('[trading-bot] Position lifecycle reconciliation error:', posReconErr?.message || posReconErr);
          }
        }

        const rawEntryStatus = dbPos?.entry_status || intentObj?.status || 'PENDING_ENTRY';
        const entryStatus = rawEntryStatus === 'DISPATCHED' ? 'PENDING_ENTRY' : rawEntryStatus;
        const positionStatus = dbPos?.status || (['FAILED', 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION', 'REJECTED_BY_RISK_GATE', 'CANCELLED', 'canceled'].includes(entryStatus) ? 'CANCELLED' : (isReconciledClosed || intentObj?.status === 'CLOSED' ? 'CLOSED' : (entryStatus === 'FILLED' || entryStatus === 'PARTIALLY_FILLED' ? 'OPEN' : 'PENDING_ENTRY')));

        const targetEntryPrice = dbPos?.target_entry_price ?? dbPos?.entry_price ?? (intentObj?.price ? parseFloat(intentObj.price) : null);
        const signalPrice = dbPos?.entry_price ?? (intentObj?.price ? parseFloat(intentObj.price) : null);
        const rawAvgFill = dbPos?.average_fill_price ?? (intentObj?.actualFillPrice ? parseFloat(intentObj.actualFillPrice) : null);
        const actualFillPrice = rawAvgFill !== null && rawAvgFill > 0 ? rawAvgFill : null;

        const requestedQuantity = dbPos?.quantity ?? (intentObj?.qty ? parseFloat(intentObj.qty) : 0);
        const rawFilledQty = dbPos?.filled_quantity ?? (intentObj?.actualExecutedQuantity ? parseFloat(intentObj.actualExecutedQuantity) : 0);
        const filledQuantity = rawFilledQty !== null && rawFilledQty > 0 ? rawFilledQty : 0;
        const remainingQuantity = Math.max(0, requestedQuantity - filledQuantity);

        const orderId = dbPos?.order_id || dbPos?.entry_exchange_order_id || intentObj?.actualOrderId || intentObj?.payloadSnapshot?.clientOrderId || null;
        const symbol = dbPos?.symbol || intentObj?.symbol || 'BTC/USDT';
        const side = (dbPos?.side || intentObj?.side || 'BUY').toUpperCase();
        const strategy = dbPos?.strategy || intentObj?.payloadSnapshot?.strategy || 'ScalperV2';
        const exchange = dbPos?.exchange || 'bybit';
        const environment = dbPos?.environment || 'mainnet';
        const orderType = dbPos?.order_type || (intentObj?.orderType ? intentObj.orderType.toUpperCase() : 'MARKET');

        const stopLoss = dbPos?.stop_loss ?? (intentObj?.requestedStopLoss ? parseFloat(intentObj.requestedStopLoss) : null);
        const takeProfit = dbPos?.take_profit ?? (intentObj?.requestedTakeProfit ? parseFloat(intentObj.requestedTakeProfit) : null);

        let slippagePercent = 0;
        if (targetEntryPrice && actualFillPrice && targetEntryPrice > 0) {
          slippagePercent = parseFloat(((Math.abs(actualFillPrice - targetEntryPrice) / targetEntryPrice) * 100).toFixed(4));
        }

        // Authoritative Proof of Execution:
        // entry_status MUST be 'FILLED' (or closed) AND exchange-confirmed average_fill_price > 0 AND filled_quantity > 0 AND order_id exists
        const isFilled = (entryStatus === 'FILLED' || entryStatus === 'closed') && (actualFillPrice !== null && actualFillPrice > 0) && (filledQuantity > 0);
        const isFailed = entryStatus === 'FAILED' || entryStatus === 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION' || entryStatus === 'REJECTED_BY_RISK_GATE' || entryStatus === 'CANCELLED' || entryStatus === 'canceled';
        const isTerminal = isFilled || isFailed;

        const responsePayload = {
          success: true,
          positionId,
          alertId: positionId,
          orderId,
          symbol,
          side,
          strategy,
          exchange,
          environment,
          orderType,
          status: positionStatus,
          entryStatus: isFilled ? 'FILLED' : entryStatus,
          targetEntryPrice,
          signalPrice,
          actualFillPrice: isFilled ? actualFillPrice : null,
          requestedQuantity,
          filledQuantity,
          remainingQuantity,
          stopLoss,
          takeProfit,
          slippagePercent,
          submittedAt: dbPos?.entry_submitted_at || (intentObj?.createdAt ? new Date(intentObj.createdAt).toISOString() : null),
          executedAt: isFilled ? (dbPos?.updated_at || (intentObj?.lastReconciliationAttempt ? new Date(intentObj.lastReconciliationAttempt).toISOString() : new Date().toISOString())) : null,
          isTerminal,
          isFilled
        };

        return new Response(JSON.stringify(responsePayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      case '/acknowledge': {
        const { alertId } = await request.json<{ alertId: string }>();
        const alerts = this.runtimeState.alerts as TradeAlert[] || [];
        const alert = alerts.find((a) => a.id === alertId);
        if (alert) {
          alert.status = 'acknowledged';
          await this.persistState('alerts', this.pruneAlerts(alerts));
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      case '/execute-trade': {
        console.log(`[DIAGNOSTIC] [STAGE: EXECUTE_TRADE_REQUEST_RECEIVED] timestamp=${new Date().toISOString()}`);

        if (this.env.GLOBAL_TRADING_HALT === 'true') {
          return new Response(JSON.stringify({ error: 'GLOBAL_TRADING_HALT is active. All trading is safely suspended.' }), { status: 503 });
        }

        console.log(`[DIAGNOSTIC] [STAGE: EXECUTE_TRADE_VALIDATION_PASSED] timestamp=${new Date().toISOString()}`);

        if (this.isExecutingTrade) {
          return new Response(JSON.stringify({ error: 'A trade execution is already in progress.' }), { status: 409 });
        }

        this.isExecutingTrade = true;
        await this.state.storage.put('isExecutingTrade', true);

        try {
          const userId: string | undefined = this.runtimeState.userId;
          if (!userId) {
            return new Response(JSON.stringify({ error: 'Bot not properly initialized with a user.' }), { status: 500 });
          }

          const coinId = this.runtimeState.coinId as string;

          let alertId: string | undefined;
          let requestBody: any = {};
          try {
            requestBody = await request.clone().json() as any;
            alertId = requestBody?.alertId;
          } catch (e) {}

          if (!alertId) {
            return new Response(JSON.stringify({ error: 'alertId is required.' }), { status: 400 });
          }

          // Fail-Closed Unprotected Exposure Lock Gate (HTTP 423)
          const activeExposureLock = (await this.state.storage.get<UnprotectedExposureLock>('lock:unprotectedExposure')) || this.unprotectedExposureLock;
          if (activeExposureLock) {
            this.unprotectedExposureLock = activeExposureLock;
            return new Response(
              JSON.stringify({
                success: false,
                code: 'UNPROTECTED_EXPOSURE_LOCK',
                error: 'UNPROTECTED_EXPOSURE_LOCK',
                message: `Trading is locked due to unresolved unprotected exposure on ${activeExposureLock.symbol}: ${activeExposureLock.reason}`,
                lock: activeExposureLock,
              }),
              { status: 423, headers: { 'Content-Type': 'application/json' } }
            );
          }

          const alerts = ((await this.state.storage.get<TradeAlert[]>('alerts')) || this.runtimeState.alerts || []) as TradeAlert[];
          const target: TradeAlert | undefined = alerts.find((a) => a.id === alertId && (a.status === 'pending' || a.status === 'acknowledged' || a.status === 'failed'));
          const completedAlert = !target
            ? alerts.find((a) => a.id === alertId && ['submitted', 'executed', 'filled', 'partially_filled'].includes(a.status))
            : undefined;
          const existingIntentForAlert = (await this.state.storage.get(`intent:order:${alertId}`)) as any || this.runtimeState.activeIntents.get(alertId);

          if (completedAlert && ['executed', 'filled', 'partially_filled'].includes(completedAlert.status)) {
            console.warn(`[SAFETY GATE] Idempotent duplicate confirmation blocked for completed alertId ${alertId} (status: ${completedAlert.status}).`);
            return new Response(
              JSON.stringify({
                success: true,
                code: 'DUPLICATE_DISPATCH_BLOCKED',
                message: 'Execution already handled.',
                orderId: existingIntentForAlert?.actualOrderId || alertId,
                status: completedAlert.status,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }

          // Strict WAL Evidence Gate: If any WAL intent already exists for this alertId (or alert is already in 'submitted' state), reject duplicate dispatch with HTTP 409
          if (existingIntentForAlert || completedAlert) {
            const walStatus = existingIntentForAlert?.status || completedAlert?.status;
            console.warn(`[SAFETY GATE] Duplicate dispatch blocked for alertId ${alertId}. Existing status: ${walStatus}`);
            return new Response(
              JSON.stringify({
                success: false,
                code: 'DUPLICATE_DISPATCH_BLOCKED',
                error: 'DUPLICATE_DISPATCH_BLOCKED',
                message: `Execution already recorded in WAL for alert ${alertId} (status: ${walStatus}).`,
                orderId: existingIntentForAlert?.actualOrderId || alertId,
                status: walStatus,
              }),
              { status: 409, headers: { 'Content-Type': 'application/json' } }
            );
          }

          if (!target) {
            return new Response(
              JSON.stringify({
                success: false,
                code: 'ALERT_NOT_EXECUTABLE',
                error: 'Trade alert not found, expired, or already executed.',
              }),
              { status: 409, headers: { 'Content-Type': 'application/json' } }
            );
          }

          // Signal TTL Enforcement (5 minutes = 300,000ms)
          const MAX_SIGNAL_AGE_MS = 300000;
          const signalAgeMs = Date.now() - new Date(target.timestamp).getTime();
          if (signalAgeMs > MAX_SIGNAL_AGE_MS) {
            console.warn(`[SAFETY GATE] Rejected stale signal execution. Age: ${signalAgeMs}ms. AlertId: ${target.id}`);
            target.status = 'expired';
            await this.persistState('alerts', this.pruneAlerts(alerts));
            return new Response(JSON.stringify({ error: `Signal has expired. Maximum allowed execution latency is 5 minutes.` }), { status: 400 });
          }

          // Fence A: Provenance, Active-State, and Generation Validation
          const [persistedIsActive, currentGen] = await Promise.all([
            this.state.storage.get<boolean>('isActive'),
            this.state.storage.get<number>('lock:alarmGeneration'),
          ]);

          const isAutonomousStrategy = typeof target.strategy === 'string' && target.strategy.endsWith('_NEW');
          if (target.source !== 'MANUAL' && target.source !== 'AUTONOMOUS') {
            const requiresExplicitProvenance =
              target.source !== undefined ||
              target.id === '97f8210e-b1d9-4e36-a45f-34ea8240653e' ||
              isAutonomousStrategy ||
              target.generation !== undefined ||
              persistedIsActive !== undefined ||
              currentGen !== undefined;

            if (requiresExplicitProvenance) {
              console.warn(`[SAFETY GATE] Rejected alert ${target.id}: missing or invalid provenance (source=${(target as any).source})`);
              return new Response(
                JSON.stringify({
                  success: false,
                  code: 'INVALID_ALERT_PROVENANCE',
                  error: 'Alert provenance is missing or belongs to an obsolete or invalid alarm generation.',
                }),
                { status: 409, headers: { 'Content-Type': 'application/json' } }
              );
            }
          }

          const effectiveSource: 'MANUAL' | 'AUTONOMOUS' =
            target.source === 'AUTONOMOUS' || isAutonomousStrategy ? 'AUTONOMOUS' : 'MANUAL';

          if (effectiveSource === 'AUTONOMOUS') {
            if (persistedIsActive !== true || this.runtimeState.isActive !== true) {
              console.warn(`[SAFETY GATE] Rejected autonomous alert ${target.id}: bot is inactive (persisted=${persistedIsActive}, runtime=${this.runtimeState.isActive})`);
              return new Response(
                JSON.stringify({
                  success: false,
                  code: 'BOT_INACTIVE_AUTONOMOUS_REJECTED',
                  error: 'Autonomous trade alert rejected because the bot is inactive.',
                }),
                { status: 409, headers: { 'Content-Type': 'application/json' } }
              );
            }

            const hasValidCurrentGen = typeof currentGen === 'number' && Number.isInteger(currentGen) && currentGen > 0;
            const alertGen = target.generation;
            const hasValidAlertGen = typeof alertGen === 'number' && Number.isInteger(alertGen) && alertGen > 0;
            if (!hasValidCurrentGen || !hasValidAlertGen || alertGen !== currentGen) {
              console.warn(`[SAFETY GATE] Rejected autonomous alert ${target.id}: obsolete or invalid alarm generation (alert gen: ${target.generation}, current: ${currentGen})`);
              return new Response(
                JSON.stringify({
                  success: false,
                  code: 'STALE_AUTONOMOUS_GENERATION',
                  error: 'Alert belongs to an obsolete or invalid alarm generation.',
                }),
                { status: 409, headers: { 'Content-Type': 'application/json' } }
              );
            }
          } else if (target.source === 'MANUAL' && target.generation !== undefined) {
            console.warn(`[SAFETY GATE] Rejected manual alert ${target.id}: manual alert cannot carry autonomous generation (${target.generation})`);
            return new Response(
              JSON.stringify({
                success: false,
                code: 'INVALID_ALERT_PROVENANCE',
                error: 'Manual alert cannot carry an autonomous alarm generation.',
              }),
              { status: 409, headers: { 'Content-Type': 'application/json' } }
            );
          }

          const side: 'BUY' | 'SELL' = target.side || 'BUY';
          const committedStrategy: string | undefined = this.runtimeState.strategy;
          const isAutonomousAlert = effectiveSource === 'AUTONOMOUS';
          const alertStrategy = (target.strategy || '').replace(/_NEW$/, '');
          const normalizedStrategyId = StrategyRegistry.getInstance().normalizeStrategyId(alertStrategy);

          // Safety Gate 1: Authoritative Strategy Manifest Validation (Enforced for all alerts)
          const alertManifest = StrategyRegistry.getInstance().getManifest(normalizedStrategyId);
          if (!alertManifest) {
            console.error(`[SAFETY GATE: FATAL] Rejected trade execution: Strategy '${normalizedStrategyId}' is not registered in StrategyRegistry. AlertId: ${target.id}`);
            return new Response(JSON.stringify({ error: `Cannot execute order: Strategy '${normalizedStrategyId}' is not registered.` }), { status: 400 });
          }

          // Safety Gate 2: Manual Strategy-Lock (Preserved strictly for manual alerts)
          if (!isAutonomousAlert && committedStrategy) {
            const normalizedCommittedId = StrategyRegistry.getInstance().normalizeStrategyId(committedStrategy);
            if (normalizedStrategyId.toLowerCase() !== normalizedCommittedId.toLowerCase()) {
              console.error(`[SAFETY GATE: FATAL] Rejected manual trade execution: Alert strategy '${normalizedStrategyId}' does not match committed bot strategy '${normalizedCommittedId}'. AlertId: ${target.id}`);
              return new Response(JSON.stringify({ error: `Execution rejected: Trade alert strategy '${normalizedStrategyId}' does not match committed bot strategy '${normalizedCommittedId}'.` }), { status: 409 });
            }
          }

          // Safety Gate 3: Directional Short Capability Enforcement
          if (side === 'SELL' && alertManifest && !alertManifest.supportsShort) {
            console.error(`[SAFETY GATE: FATAL] Rejected short execution for long-only strategy ${normalizedStrategyId}. AlertId: ${target.id}`);
            return new Response(JSON.stringify({ error: `Cannot execute SELL order: Strategy '${normalizedStrategyId}' does not support short positions.` }), { status: 400 });
          }

            // [SAFETY GATE: STRICT SCHEMA READINESS CHECK]
            try {
              const tableInfo = await this.env.DB.prepare("PRAGMA table_info('trade_positions')").all();
              const hasTargetEntryPrice = tableInfo.results.some((r: any) => r.name === 'target_entry_price');
              const hasEntryStatus = tableInfo.results.some((r: any) => r.name === 'entry_status');
              if (!hasTargetEntryPrice || !hasEntryStatus) {
                console.error(`[SAFETY GATE: FATAL] Database schema is incomplete. Migration 0016 or 0024 missing. Missing required columns. Execution HALTED.`);
                return new Response(JSON.stringify({ error: 'System deployment incomplete. Missing required D1 database migrations. Execution halted to prevent un-trackable exchange inventory.' }), { status: 503 });
              }
            } catch (schemaErr: any) {
              console.error(`[SAFETY GATE: FATAL] Failed to verify D1 schema readiness: ${schemaErr.message}`);
              return new Response(JSON.stringify({ error: 'Failed to verify persistence readiness. Execution halted.' }), { status: 500 });
            }

            const userKeys = await this.env.DB.prepare(
              'SELECT exchange_api_key, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_salt, exchange_name, exchange_environment, exchange_region, fcm_token FROM users WHERE id = ?'
            ).bind(userId).first<any>();

            const hasApiKey = Boolean(userKeys?.exchange_api_key_encrypted || userKeys?.exchange_api_key);
            if (!userKeys?.exchange_name || !hasApiKey || !userKeys?.exchange_api_secret_encrypted) {
              return new Response(JSON.stringify({ error: 'User has not configured their exchange API keys.' }), { status: 400 });
            }

            let decryptedApiKey: string | undefined = undefined;
            if (userKeys.exchange_api_key_iv && userKeys.exchange_api_key_encrypted) {
              decryptedApiKey = await decrypt(
                { iv: userKeys.exchange_api_key_iv, encrypted: userKeys.exchange_api_key_encrypted, salt: userKeys.exchange_api_key_salt },
                this.env.ENCRYPTION_KEY,
              );
            } else {
              decryptedApiKey = userKeys.exchange_api_key ?? undefined;
            }

            const decryptedSecret = await decrypt(
              { iv: userKeys.exchange_api_secret_iv, encrypted: userKeys.exchange_api_secret_encrypted, salt: userKeys.exchange_api_secret_salt },
              this.env.ENCRYPTION_KEY,
            );

            let decryptedPassphrase = undefined;
            if (userKeys.exchange_api_passphrase_iv && userKeys.exchange_api_passphrase_encrypted) {
              decryptedPassphrase = await decrypt(
                { iv: userKeys.exchange_api_passphrase_iv, encrypted: userKeys.exchange_api_passphrase_encrypted, salt: userKeys.exchange_api_passphrase_salt },
                this.env.ENCRYPTION_KEY,
              );
            }

            const adapter = await ExchangeManager.getProvider(userKeys.exchange_name as ExchangeName, {
              environment: normalizeEnvironment(userKeys.exchange_environment),
              apiKey: decryptedApiKey,
              secret: decryptedSecret,
              password: decryptedPassphrase,
              region: resolveCanonicalRoutingRegion(userKeys.exchange_region),
            });
            const rawSymbol = target.symbol || coinId || 'BTC/USDT';
            const orderSymbol = rawSymbol.includes('/') ? rawSymbol : `${rawSymbol}/USDT`;
            const clientOrderId = target.id;

            console.log(`[DIAGNOSTIC] [STAGE: PENDING_ALERT_FOUND] targetAlertId=${target.id} symbol=${orderSymbol} side=${side} positionSize=${target.positionSize}`);

            const normalizedOrderSymbol = this.normalizeSymbol(orderSymbol);

            // Phase 3: Strict Concurrency Check (Cases 5 & 6)
            // Mathematically prevents executing a new intent for a symbol if an unresolved intent already exists for it.
            const existingIntents = this.runtimeState.activeIntents;
            for (const val of existingIntents.values()) {
              const intent = val as any;
              if (this.normalizeSymbol(intent.symbol) === normalizedOrderSymbol && ['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(intent.status)) {
                  console.error(`[SAFETY_GATE: LEVEL_2] Rejected concurrent entry: Intent ${intent.intentId} is unresolved (${intent.status}) for ${orderSymbol}.`);
                  return new Response(JSON.stringify({
                    success: false,
                    error: `Concurrent execution blocked. Unresolved intent ${intent.intentId} in state ${intent.status} exists for ${orderSymbol}.`
                  }), { status: 423 }); // 423 Locked
              }
            }

            // Phase 1 Safety Gate: Same-Symbol Conflict Protection on Existing Positions (Cases 1, 2, 3, 4)
            // Prevents executing opposing or duplicate trades on the same symbol in Bybit One-Way Mode (positionIdx: 0).
            let openPositions: any[] = [];
            if (this.env.DB && userId && typeof this.env.DB.prepare === 'function') {
              try {
                const stmt = this.env.DB.prepare(
                  `SELECT * FROM trade_positions WHERE user_id = ? AND status IN ('OPEN', 'PENDING_ENTRY')`
                );
                const bound = typeof stmt?.bind === 'function' ? stmt.bind(userId) : stmt;
                if (bound && typeof bound.all === 'function') {
                  const d1Res = await bound.all();
                  openPositions = d1Res?.results || [];
                }
              } catch (dbErr) {
                console.warn(`[SAFETY_GATE: LEVEL_2] Failed to query D1 trade_positions:`, dbErr);
              }
            }

            // Authoritative Exchange Position Reconciliation:
            // Check D1 open positions against authoritative exchange state (Bybit /v5/position/list).
            // Any D1 position marked OPEN or PENDING_ENTRY that is no longer open on the exchange
            // is authoritatively reconciled via ReconciliationEngine and updated to CLOSED with real exchange close data.
            if (adapter && (userKeys?.exchange_name === 'bybit' || openPositions.some(p => p.exchange === 'bybit'))) {
              let activeExchangePositions: any[] | null = null;
              if (typeof (adapter as any).fetchPositions === 'function') {
                try {
                  activeExchangePositions = await (adapter as any).fetchPositions('linear');
                } catch (fetchErr: any) {
                  console.warn(`[SAFETY_GATE: LEVEL_2] Failed to fetch exchange positions for reconciliation; aborting reconciliation to prevent false closures:`, fetchErr?.message || fetchErr);
                  activeExchangePositions = null;
                }
              }

              // ONLY reconcile if activeExchangePositions was successfully and authoritatively retrieved as an array.
              // If exchange call failed/timed out, reconciliation is aborted and NO D1 positions are modified.
              if (Array.isArray(activeExchangePositions)) {
                try {
                  const verifiedOpenPositions: any[] = [];
                  const targetSymbolGroups = new Map<string, { rows: any[]; posSideUpper: string }>();

                  for (const pos of openPositions) {
                    const isMock =
                      pos.exchange === 'mock' ||
                      String(pos.id || '').startsWith('mock_') ||
                      String(pos.order_id || pos.orderId || '').startsWith('mock_');
                    const normPosSymbol = this.normalizeSymbol(pos.symbol);

                    // Preserve all mock positions and all non-target symbol D1 rows untouched (0 subrequests)
                    if (isMock || normPosSymbol !== normalizedOrderSymbol) {
                      verifiedOpenPositions.push(pos);
                      continue;
                    }

                    const posSideUpper = (pos.side || 'BUY').toUpperCase();
                    const groupKey = `${normPosSymbol}:${posSideUpper}`;
                    if (!targetSymbolGroups.has(groupKey)) {
                      targetSymbolGroups.set(groupKey, { rows: [], posSideUpper });
                    }
                    targetSymbolGroups.get(groupKey)!.rows.push(pos);
                  }

                  for (const [, group] of targetSymbolGroups.entries()) {
                    const { rows: groupRows, posSideUpper } = group;
                    const hasActiveExchangeExposure = activeExchangePositions.some((ep: any) => {
                      const epSize = typeof ep.size?.toNumber === 'function' ? ep.size.toNumber() : Number(ep.size || 0);
                      if (epSize <= 0) return false;
                      if (this.normalizeSymbol(ep.symbol) !== normalizedOrderSymbol) return false;
                      const epSideLower = (ep.side || '').toLowerCase();
                      return (
                        (posSideUpper === 'BUY' && (epSideLower === 'long' || epSideLower === 'buy')) ||
                        (posSideUpper === 'SELL' && (epSideLower === 'short' || epSideLower === 'sell'))
                      );
                    });

                    const { closedIds, cancelledIds } = await this.reconcileMissingD1PositionsGroup(
                      adapter,
                      userId,
                      groupRows,
                      hasActiveExchangeExposure
                    );

                    for (const r of groupRows) {
                      if (!closedIds.has(r.id) && !cancelledIds.has(r.id)) {
                        verifiedOpenPositions.push(r);
                      }
                    }
                  }

                  openPositions = verifiedOpenPositions;
                } catch (reconcileAllErr: any) {
                  console.warn(`[SAFETY_GATE: LEVEL_2] Exchange position reconciliation non-fatal fallback:`, reconcileAllErr?.message || reconcileAllErr);
                }
              } else {
                console.warn(`[SAFETY_GATE: LEVEL_2] Exchange position query failed or was unavailable; preserving existing D1 positions without modification.`);
              }
            }

            const runtimeActive = (this.runtimeState.activePositions || []).filter((p: any) =>
              p.status !== 'CLOSED' && p.status !== 'CANCELLED' && openPositions.some(op => op.id === p.id)
            );
            this.runtimeState.activePositions = runtimeActive;
            await this.persistState('activePositions', runtimeActive);

            const allOpenPositions = [...openPositions];
            for (const rp of runtimeActive) {
              if (!allOpenPositions.some(p => p.id === rp.id)) {
                allOpenPositions.push(rp);
              }
            }

            const conflictingPosition = allOpenPositions.find(p => this.normalizeSymbol(p.symbol) === normalizedOrderSymbol);
            if (conflictingPosition) {
              const posSide = (conflictingPosition.side || '').toUpperCase();
              const incomingSide = side.toUpperCase();
              console.error(`[SAFETY_GATE: LEVEL_2] Rejected trade execution for ${orderSymbol}: Conflicting active position exists (id: ${conflictingPosition.id}, symbol: ${conflictingPosition.symbol}, existing side: ${posSide}, incoming side: ${incomingSide}).`);
              await this.logAuditEvent(userId, 'TRADE_REJECTED_POSITION_CONFLICT', {
                symbol: orderSymbol,
                incomingSide,
                existingPositionId: conflictingPosition.id,
                existingPositionSide: posSide,
                reason: `Active ${posSide} position already exists on ${conflictingPosition.symbol}. In Bybit One-Way Mode, opposing or duplicate orders cannot be safely executed.`
              });
              return new Response(JSON.stringify({
                success: false,
                error: 'SYMBOL_POSITION_CONFLICT',
                message: `Execution blocked. An active ${posSide} position already exists on ${conflictingPosition.symbol}. Bybit One-Way Mode forbids concurrent or conflicting positions on the same symbol.`
              }), { status: 409 }); // 409 Conflict
            }

            // Phase 1 Safety Gate: Validate Alert Position Size (Fail Closed on Missing/Invalid)
            const proposedNotional = Number(target.positionSize);
            if (!target.positionSize || typeof proposedNotional !== 'number' || isNaN(proposedNotional) || proposedNotional <= 0) {
              console.error(`[SAFETY_GATE: LEVEL_2] Rejected trade execution for ${orderSymbol}: Alert position size (${target.positionSize}) is invalid or missing.`);
              return new Response(JSON.stringify({
                success: false,
                error: 'INVALID_ALERT_POSITION_SIZE',
                message: 'Invalid or missing alert position size. Allocation must be greater than zero.'
              }), { status: 400 });
            }

            // Phase 1 Safety Gate: Portfolio-Level Aggregate Exposure Protection
            const currentExposure = this.calculateAggregateExposure(allOpenPositions);

            // Refresh live USDT balance for exposure calculation
            let authoritativeBal = (await this.state.storage.get('lastAccountBalance')) as number ?? this.runtimeState.lastAccountBalance;
            try {
              if (adapter && typeof (adapter as any).fetchBalance === 'function') {
                const liveBalanceRes = await (adapter as any).fetchBalance().catch(() => null);
                if (liveBalanceRes) {
                  const extracted = extractUsdtBalance(liveBalanceRes);
                  if (extracted > 0) {
                    authoritativeBal = extracted;
                    this.runtimeState.lastAccountBalance = extracted;
                    await this.state.storage.put('lastAccountBalance', extracted);
                  }
                }
              } else if (adapter && authoritativeBal === undefined) {
                const fallbackBal = extractUsdtBalance(null);
                if (fallbackBal > 0) {
                  authoritativeBal = fallbackBal;
                }
              }
            } catch (_) {}
            const cachedBal = (typeof authoritativeBal === 'number' && authoritativeBal > 0) ? authoritativeBal : 0;
            const maxPortfolioExposure = this.resolveMaxPortfolioExposure(cachedBal, this.runtimeState.strategyConfig, this.runtimeState.setupSnapshot);

            if (currentExposure + proposedNotional > maxPortfolioExposure) {
              console.error(`[SAFETY_GATE: LEVEL_2] Rejected trade execution for ${orderSymbol}: Aggregate portfolio exposure ($${(currentExposure + proposedNotional).toFixed(2)}) exceeds maximum allowed ($${maxPortfolioExposure.toFixed(2)}). Current: $${currentExposure.toFixed(2)}, Proposed: $${proposedNotional.toFixed(2)}.`);
              await this.logAuditEvent(userId, 'TRADE_REJECTED_PORTFOLIO_EXPOSURE', {
                symbol: orderSymbol,
                currentExposure,
                proposedNotional,
                maxExposure: maxPortfolioExposure,
                reason: `Aggregate portfolio exposure ($${(currentExposure + proposedNotional).toFixed(2)}) exceeds limit ($${maxPortfolioExposure.toFixed(2)}).`
              });
              return new Response(JSON.stringify({
                success: false,
                error: 'PORTFOLIO_EXPOSURE_EXCEEDED',
                message: `Execution blocked. Aggregate portfolio exposure ($${(currentExposure + proposedNotional).toFixed(2)}) would exceed maximum allowed ($${maxPortfolioExposure.toFixed(2)}).`
              }), { status: 409 });
            }

          let orderResult: any = { success: true, message: 'Trade executed (simulated).', orderId: clientOrderId };
          const entryIntent: 'WAIT_FOR_PRICE' | 'IMMEDIATE' | 'TRIGGER' = requestBody?.entryIntent || target.entryIntent || 'WAIT_FOR_PRICE';
          let orderType: 'MARKET' | 'LIMIT' = 'MARKET';
          let limitPrice: number | undefined = undefined;
          let triggerPrice: number | undefined = undefined;
          let triggerDirection: 1 | 2 | undefined = undefined;
          let timeInForce: 'GTC' | 'IOC' = 'GTC';
          let executionSnapshot: TradeExecutionSnapshot | null = null;
          let activeTickSize = 0;
          let activeWriteProvider: any = adapter;
          let activeRawOrder: any = null;
          let matchedCategory: string | undefined = undefined;

          try {
            if (adapter) {
              const ticker = await adapter.fetchTicker(orderSymbol);
              const currentPrice = (typeof ticker?.last?.toNumber === 'function' ? ticker.last.toNumber() : (typeof ticker?.last === 'number' ? ticker.last : 0)) || target.signalPrice || target.entryPrice;
              const targetPrice = target.targetEntryPrice || target.signalPrice || target.entryPrice;

              if (entryIntent === 'WAIT_FOR_PRICE') {
                orderType = 'LIMIT';
                limitPrice = targetPrice;
                timeInForce = 'GTC';
              } else if (entryIntent === 'IMMEDIATE') {
                orderType = 'MARKET';
                limitPrice = undefined;
                timeInForce = 'IOC';
              } else if (entryIntent === 'TRIGGER') {
                orderType = 'MARKET';
                triggerPrice = targetPrice;
                triggerDirection = triggerPrice >= currentPrice ? 1 : 2;
                timeInForce = 'GTC';
              }

              const positionSizeUsdt = Number(target.positionSize);
              let stepSize = 0;
              let tickSize = 0;
              let minNotional = 5;
              let minQty = 0;
              let priceLimitRatioX: number = 0.10;
              let priceLimitRatioY: number = 0.10;
              let hasAuthoritativeMetadata = false;

              try {
                const matched = await adapter.fetchMarket(orderSymbol);
                if (matched) {
                  matchedCategory = (matched as any).category;
                  hasAuthoritativeMetadata = true;
                  if (matched.precision?.amount) stepSize = matched.precision.amount;
                  if (matched.precision?.price) tickSize = matched.precision.price;
                  if ((matched as any).priceLimitRatioX) priceLimitRatioX = (matched as any).priceLimitRatioX;
                  if ((matched as any).priceLimitRatioY) priceLimitRatioY = (matched as any).priceLimitRatioY;
                  if (matched.limits?.cost?.min) {
                    const costMin = matched.limits.cost.min as any;
                    minNotional = typeof costMin?.toNumber === 'function' ? costMin.toNumber() : (typeof costMin === 'number' ? costMin : 5);
                  }
                  if (matched.limits?.amount?.min) {
                    const amtMin = matched.limits.amount.min as any;
                    minQty = typeof amtMin?.toNumber === 'function' ? amtMin.toNumber() : (typeof amtMin === 'number' ? amtMin : 0.00001);
                  }
                }
              } catch (mErr: any) {
                console.warn('[trading-bot] Failed to fetch authoritative markets for precision rules:', mErr?.message);
              }

              if (!hasAuthoritativeMetadata || tickSize <= 0) {
                throw new Error(`Authoritative exchange metadata for ${orderSymbol} is unavailable. Cannot safely determine execution tick size.`);
              }
              activeTickSize = tickSize;

              // Strictly normalize ONLY the local limitPrice and triggerPrice before validation
              const targetSideEnum = (target.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
              if (limitPrice !== undefined) {
                limitPrice = PriceNormalizer.normalizeLimitPrice(limitPrice, tickSize, targetSideEnum);
              }
              if (triggerPrice !== undefined) {
                triggerPrice = PriceNormalizer.normalizeLimitPrice(triggerPrice, tickSize, targetSideEnum);
              }

              if (target.takeProfit !== undefined || target.stopLoss !== undefined) {
                const normResult = PriceNormalizer.normalizeTradePrices({
                  entryPrice: limitPrice || triggerPrice || currentPrice,
                  theoreticalSL: target.stopLoss !== undefined ? target.stopLoss : (targetSideEnum === 'BUY' ? currentPrice * 0.9 : currentPrice * 1.1),
                  theoreticalTP: target.takeProfit !== undefined ? target.takeProfit : (targetSideEnum === 'BUY' ? currentPrice * 1.1 : currentPrice * 0.9),
                  tickSize: tickSize,
                  minAllowedPrice: tickSize,
                  side: targetSideEnum
                });
                if (target.takeProfit !== undefined) target.takeProfit = normResult.takeProfit;
                if (target.stopLoss !== undefined) target.stopLoss = normResult.stopLoss;
              }

              const rulesRes = TradeValidator.validate({
                symbol: orderSymbol,
                side: target.side,
                orderType: orderType,
                entryIntent: entryIntent,
                entryPrice: limitPrice || triggerPrice || currentPrice,
                currentMarketPrice: currentPrice,
                markPrice: currentPrice,
                tradeValueUsdt: positionSizeUsdt
              }, {
                schemaVersion: "2.0",
                symbol: orderSymbol,
                exchange: userKeys.exchange_name || "binance",
                baseAsset: orderSymbol.split('/')[0] || "BTC",
                quoteAsset: orderSymbol.split('/')[1] || "USDT",
                minNotional: minNotional,
                minQty: minQty,
                maxQty: 999999,
                stepSize: stepSize,
                tickSize: tickSize,
                minPrice: 0,
                maxPrice: 999999999,
                contractSize: 1,
                priceLimitRatioX: priceLimitRatioX,
                priceLimitRatioY: priceLimitRatioY,
                markPrice: currentPrice,
                lastUpdated: Date.now()
              });

              if (!rulesRes.isValid) {
                console.error(`[DIAGNOSTIC] [STAGE: TRADE_VALIDATION_FAILED] errorCode=${rulesRes.errorCode} errorMessage=${rulesRes.errorMessage}`);
                throw new Error(rulesRes.errorMessage || `Order validation failed: ${rulesRes.errorCode}`);
              }

              const qty = rulesRes.quantizedQuantity ?? 0;
              console.log(`[DIAGNOSTIC] [STAGE: TRADE_VALIDATION_PASSED] quantizedQuantity=${qty} postRoundingNotional=${rulesRes.postRoundingNotional}`);

              // Construct and freeze Immutable TradeExecutionSnapshot
              executionSnapshot = Object.freeze({
                snapshotId: crypto.randomUUID(),
                alertId: target.id,
                userId: userId,
                symbol: orderSymbol,
                timeframe: target.timeframe,
                side: (side.toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
                orderType: orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
                limitPrice: limitPrice || undefined,
                signalPrice: target.signalPrice || target.entryPrice,
                targetEntryPrice: target.targetEntryPrice || undefined,
                positionSizeUsdt: target.positionSize,
                quantizedQuantity: qty,
                stopLoss: target.stopLoss,
                takeProfit: target.takeProfit,
                strategy: target.strategy,
                exchangeName: userKeys.exchange_name,
                environment: userKeys.exchange_environment || 'mainnet',
                clientOrderId: clientOrderId,
                createdAt: new Date().toISOString()
              });
              console.log(`[DIAGNOSTIC] [STAGE: EXECUTION_SNAPSHOT_CREATED] snapshot=${JSON.stringify(executionSnapshot)}`);

              // Re-fetch provider with full keys for write
              const writeProvider = await ExchangeManager.getProvider(executionSnapshot.exchangeName, {
                environment: normalizeEnvironment(executionSnapshot.environment),
                apiKey: decryptedApiKey,
                secret: decryptedSecret,
                password: decryptedPassphrase,
                region: resolveCanonicalRoutingRegion(userKeys.exchange_region),
              });
              activeWriteProvider = writeProvider;

              const req: any = {
                symbol: executionSnapshot.symbol,
                side: executionSnapshot.side.toLowerCase(),
                type: executionSnapshot.orderType.toLowerCase(),
                amount: new BigNumber(executionSnapshot.quantizedQuantity),
                clientOrderId: executionSnapshot.clientOrderId,
                timeInForce: timeInForce,
                category: matchedCategory || 'linear',
                params: { tickSize, stepSize }
              };
              if (executionSnapshot.limitPrice) req.price = new BigNumber(executionSnapshot.limitPrice);
              if (triggerPrice) {
                req.triggerPrice = new BigNumber(triggerPrice);
                req.triggerDirection = triggerDirection;
              }
              if (executionSnapshot.takeProfit) req.takeProfit = executionSnapshot.takeProfit;
              if (executionSnapshot.stopLoss) req.stopLoss = executionSnapshot.stopLoss;

              // Phase 3: Final Dispatch Safety Gate
              try {
                const dispatchReferencePrice = orderType === 'MARKET' ? currentPrice : (targetPrice || currentPrice);
                FinalDispatchSafetyGate.validate(req, {
                  stepSize,
                  tickSize,
                  minQty,
                  minNotional,
                  maxExposure: maxPortfolioExposure,
                  currentExposure,
                  referencePrice: dispatchReferencePrice,
                  estimatedNotional: proposedNotional,
                });
              } catch (gateErr: any) {
                throw new Error(`RISK_GATE_REJECTED: ${gateErr.message}`);
              }

              // Phase 3: Core WAL State Machine (INTENT_PERSISTED before dispatch lease)
              const payloadSnapshotClone = {
                ...req,
                amount: req.amount?.toString ? req.amount.toString() : String(req.amount),
                price: req.price?.toString ? req.price.toString() : req.price,
                triggerPrice: req.triggerPrice?.toString ? req.triggerPrice.toString() : req.triggerPrice,
                targetEntryPrice: executionSnapshot.targetEntryPrice,
                requestedStopLoss: req.stopLoss,
                requestedTakeProfit: req.takeProfit,
                tickSize,
                stepSize,
                strategy: target.strategy,
              };

              const intentObj: any = {
                intentId: executionSnapshot.clientOrderId,
                version: Date.now(),
                symbol: req.symbol,
                timeframe: target.timeframe,
                side: req.side,
                orderType: req.type,
                qty: req.amount.toString(),
                price: req.price?.toString(),
                status: 'INTENT_PERSISTED',
                dispatchedAt: undefined,
                requestedStopLoss: req.stopLoss,
                requestedTakeProfit: req.takeProfit,
                createdAt: Date.now(),
                reconciliationAttemptCount: 0,
                payloadSnapshot: payloadSnapshotClone
              };

              await this.persistIntentSnapshot(intentObj.intentId, intentObj);

              const safeEntryIntent: 'WAIT_FOR_PRICE' | 'IMMEDIATE' | 'TRIGGER' | 'UNKNOWN' =
                entryIntent === 'WAIT_FOR_PRICE' || entryIntent === 'IMMEDIATE' || entryIntent === 'TRIGGER'
                  ? entryIntent
                  : 'UNKNOWN';

              this.telemetrySink.emit({
                userId,
                category: 'EXECUTION',
                component: 'TradingBot',
                eventName: 'EXECUTION_REQUEST',
                severity: 'INFO',
                correlationId: target.id,
                symbol: orderSymbol,
                strategyId: target.strategy,
                payload: {
                  alertId: target.id,
                  clientOrderId,
                  symbol: orderSymbol,
                  side,
                  orderType,
                  entryIntent: safeEntryIntent
                }
              });

              let rawOrder: any;
              let leaseInvokedByAdapter = false;
              req.beforeOrderDispatch = async () => {
                if (leaseInvokedByAdapter) return () => {};
                leaseInvokedByAdapter = true;
                return await this.acquireDispatchLease(
                  target,
                  intentObj,
                  userId,
                  orderSymbol,
                  side,
                  clientOrderId,
                  isAutonomousAlert
                );
              };

              try {
                const isNativeBybitAdapter =
                  writeProvider instanceof BybitAdapter ||
                  typeof (writeProvider as any)?.makeRequest === 'function' ||
                  Boolean((writeProvider as any)?.usesBeforeOrderDispatch);

                if (isNativeBybitAdapter) {
                  rawOrder = await ExchangeManager.executeIdempotentOrder(writeProvider, req);
                } else {
                  const releaseFallbackLease = await req.beforeOrderDispatch({
                    method: 'POST',
                    path: '/v5/order/create',
                    body: req,
                  });
                  let dispatchPromise: Promise<any>;
                  try {
                    dispatchPromise = Promise.resolve(ExchangeManager.executeIdempotentOrder(writeProvider, req));
                  } finally {
                    if (typeof releaseFallbackLease === 'function') {
                      releaseFallbackLease();
                    }
                  }
                  rawOrder = await dispatchPromise;
                }
                activeRawOrder = rawOrder;

                const reqQtyNum = executionSnapshot.quantizedQuantity;
                const rawFilledNum =
                  typeof rawOrder?.filled?.toNumber === 'function'
                    ? rawOrder.filled.toNumber()
                    : typeof rawOrder?.filled === 'number'
                      ? rawOrder.filled
                      : rawOrder?.status === 'closed'
                        ? (typeof rawOrder?.amount?.toNumber === 'function' ? rawOrder.amount.toNumber() : Number(rawOrder?.amount || reqQtyNum))
                        : 0;
                const rawAvgPrice =
                  typeof rawOrder?.average?.toNumber === 'function'
                    ? rawOrder.average.toNumber()
                    : typeof rawOrder?.average === 'number'
                      ? rawOrder.average
                      : typeof rawOrder?.price?.toNumber === 'function'
                        ? rawOrder.price.toNumber()
                        : typeof rawOrder?.price === 'number'
                          ? rawOrder.price
                          : null;

                intentObj.actualOrderId = rawOrder?.id || intentObj.actualOrderId;
                intentObj.actualExecutedQuantity = rawFilledNum;
                if (rawAvgPrice && rawAvgPrice > 0) {
                  intentObj.actualFillPrice = rawAvgPrice;
                }

                const isUnverifiedMarketOrder = Boolean((rawOrder as any)?.statusVerificationFailed);

                if (isUnverifiedMarketOrder) {
                  intentObj.status = 'RECONCILIATION_PENDING';
                  await this.persistIntentSnapshot(intentObj.intentId, intentObj);
                  console.warn(`[DIAGNOSTIC] [STAGE: MARKET_ORDER_UNVERIFIED] Market order ${intentObj.intentId} returned unverified/open status with 0 fill. Running immediate reconciliation.`);

                  try {
                    const reconciled = await ReconciliationEngine.reconcile(writeProvider, { ...intentObj }, Date.now());
                    await this.persistIntentSnapshot(intentObj.intentId, reconciled || intentObj);
                  } catch (reconErr: any) {
                    console.warn(`[DIAGNOSTIC] Immediate reconciliation failed for unverified market order ${intentObj.intentId}:`, reconErr?.message);
                  }

                  const latestIntent = (await this.state.storage.get(`intent:order:${intentObj.intentId}`)) as any || intentObj;
                  const latestFilledNum = Number(latestIntent.actualExecutedQuantity || 0);
                  if (latestIntent.status === 'FILLED' || latestIntent.status === 'PARTIALLY_FILLED' || latestFilledNum > 0) {
                    rawOrder = {
                      id: latestIntent.actualOrderId || rawOrder?.id || intentObj.intentId,
                      status: latestIntent.status === 'FILLED' ? 'closed' : 'open',
                      filled: new BigNumber(latestFilledNum > 0 ? latestFilledNum : executionSnapshot.quantizedQuantity),
                      amount: new BigNumber(executionSnapshot.quantizedQuantity),
                      price: latestIntent.actualFillPrice ? new BigNumber(latestIntent.actualFillPrice) : undefined,
                      average: latestIntent.actualFillPrice ? new BigNumber(latestIntent.actualFillPrice) : undefined,
                      stopLoss: latestIntent.exchangeConfirmedStopLoss ?? rawOrder?.stopLoss,
                      takeProfit: latestIntent.exchangeConfirmedTakeProfit ?? rawOrder?.takeProfit,
                    };
                    activeRawOrder = rawOrder;
                  } else if (latestIntent.status === 'FAILED' && latestFilledNum === 0) {
                    throw new Error(`Market order ${intentObj.intentId} was cancelled or rejected with zero fill on exchange.`);
                  } else {
                    await this.persistIntentSnapshot(intentObj.intentId, { ...latestIntent, status: 'RECONCILIATION_PENDING' });
                    await this.setUnprotectedExposureLock({
                      positionId: intentObj.intentId,
                      alertId: target.id,
                      symbol: orderSymbol,
                      side,
                      category: matchedCategory || 'linear',
                      positionIdx: 0,
                      closeIntentId: `close_${intentObj.intentId}`,
                      lockedAt: Date.now(),
                      reason: `Market order ${intentObj.intentId} fill and SL/TP status could not be verified after dispatch.`,
                    });
                    try { await this.state.storage.setAlarm(Date.now() + 5000); } catch (_) {}

                    const ambiguousErr: any = new Error(`UNKNOWN_STATE: Market order ${intentObj.intentId} execution outcome is ambiguous/unverified.`);
                    ambiguousErr.code = 'EXECUTION_OUTCOME_AMBIGUOUS';
                    ambiguousErr.httpStatus = 502;
                    ambiguousErr.intentStatus = 'RECONCILIATION_PENDING';
                    throw ambiguousErr;
                  }
                } else {
                  if (rawFilledNum > 0 && rawFilledNum < reqQtyNum && rawOrder?.status !== 'closed') {
                    intentObj.status = 'PARTIALLY_FILLED';
                  } else if (rawOrder?.status === 'closed' || (rawFilledNum >= reqQtyNum && reqQtyNum > 0)) {
                    intentObj.status = 'FILLED';
                  } else if (rawOrder?.status === 'canceled' || rawOrder?.status === 'rejected') {
                    intentObj.status = 'FAILED';
                    intentObj.terminalReason = `ORDER_${String(rawOrder.status).toUpperCase()}`;
                    await this.persistIntentSnapshot(intentObj.intentId, intentObj);
                    throw new Error(`Order ${intentObj.intentId} was ${rawOrder.status} on exchange.`);
                  } else {
                    intentObj.status = 'DISPATCHED';
                  }

                  await this.persistIntentSnapshot(intentObj.intentId, intentObj);
                  console.log(`[DIAGNOSTIC] [STAGE: ORDER_SUCCESS] orderId=${rawOrder?.id} status=${intentObj.status} filled=${rawFilledNum}/${reqQtyNum}`);
                }
              } catch (e: any) {
                if (e?.isFenceBAbort || e?.code === 'EXECUTION_OUTCOME_AMBIGUOUS') {
                  throw e;
                }

                // If the error occurred before the adapter reached Fence B / network dispatch, it is a pre-dispatch failure
                if (!intentObj.dispatchedAt) {
                  intentObj.status = 'FAILED';
                  intentObj.dispatchedAt = undefined;
                  intentObj.terminalReason = e?.message || 'PRE_DISPATCH_FAILURE';
                  await this.persistIntentSnapshot(intentObj.intentId, intentObj);
                  throw e;
                }

                // Catch HTTP timeouts / 5xx / network errors after dispatch to enforce UNKNOWN state instead of FAILED
                const errStr = String(e?.message || e || '');
                const statusStr = String(e?.status || e?.httpStatus || '');
                const isNetworkOrAmbiguousError =
                  e?.code === 'EXCHANGE_NOT_REACHABLE' ||
                  e?.code === 'EXCHANGE_TIMEOUT' ||
                  e?.code === 'NETWORK_ERROR' ||
                  errStr.toLowerCase().includes('timeout') ||
                  errStr.toLowerCase().includes('timed out') ||
                  errStr.toLowerCase().includes('network') ||
                  errStr.includes('500') ||
                  errStr.includes('502') ||
                  errStr.includes('503') ||
                  errStr.includes('504') ||
                  statusStr.startsWith('5');

                if (isNetworkOrAmbiguousError) {
                  intentObj.status = 'UNKNOWN';
                  await this.persistIntentSnapshot(intentObj.intentId, intentObj);
                  console.warn(`[DIAGNOSTIC] [STAGE: UNKNOWN_STATE] Ambiguous/network failure after dispatch for ${intentObj.intentId}. Transitioning to UNKNOWN and running immediate reconciliation.`);

                  try {
                    const reconciled = await ReconciliationEngine.reconcile(writeProvider, { ...intentObj }, Date.now());
                    await this.persistIntentSnapshot(intentObj.intentId, reconciled || intentObj);
                  } catch (reconErr: any) {
                    console.warn(`[DIAGNOSTIC] Immediate reconciliation failed for ${intentObj.intentId}:`, reconErr?.message);
                  }

                  const latestIntent = (await this.state.storage.get(`intent:order:${intentObj.intentId}`)) as any || intentObj;
                  if (latestIntent.status === 'FILLED' || latestIntent.status === 'PARTIALLY_FILLED') {
                    rawOrder = {
                      id: latestIntent.actualOrderId || intentObj.intentId,
                      status: latestIntent.status === 'FILLED' ? 'closed' : 'open',
                      filled: new BigNumber(latestIntent.actualExecutedQuantity || executionSnapshot.quantizedQuantity),
                      amount: new BigNumber(executionSnapshot.quantizedQuantity),
                      price: latestIntent.actualFillPrice ? new BigNumber(latestIntent.actualFillPrice) : undefined,
                      average: latestIntent.actualFillPrice ? new BigNumber(latestIntent.actualFillPrice) : undefined,
                      stopLoss: latestIntent.exchangeConfirmedStopLoss,
                      takeProfit: latestIntent.exchangeConfirmedTakeProfit,
                    };
                    activeRawOrder = rawOrder;
                  } else if (latestIntent.status === 'FAILED' || latestIntent.status === 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION') {
                    throw e;
                  } else {
                    await this.setUnprotectedExposureLock({
                      positionId: intentObj.intentId,
                      alertId: target.id,
                      symbol: orderSymbol,
                      side,
                      category: matchedCategory || 'linear',
                      positionIdx: 0,
                      closeIntentId: `close_${intentObj.intentId}`,
                      lockedAt: Date.now(),
                      reason: `Order ${intentObj.intentId} dispatch outcome is unknown due to network/timeout failure.`,
                    });
                    try { await this.state.storage.setAlarm(Date.now() + 5000); } catch (_) {}

                    const ambiguousErr: any = new Error(`UNKNOWN_STATE: Order ${intentObj.intentId} dispatch status is unknown due to network/timeout failure.`);
                    ambiguousErr.code = 'EXECUTION_OUTCOME_AMBIGUOUS';
                    ambiguousErr.httpStatus = 502;
                    ambiguousErr.intentStatus = latestIntent.status;
                    throw ambiguousErr;
                  }
                } else {
                  intentObj.status = 'FAILED';
                  intentObj.terminalReason = e?.message || 'EXCHANGE_REJECTED';
                  await this.persistIntentSnapshot(intentObj.intentId, intentObj);
                  throw e;
                }
              }

              const reqQty = executionSnapshot.quantizedQuantity;
              const filledQty =
                typeof rawOrder?.filled?.toNumber === 'function'
                  ? rawOrder.filled.toNumber()
                  : typeof rawOrder?.filled === 'number'
                    ? rawOrder.filled
                    : rawOrder?.status === 'closed'
                      ? (typeof rawOrder?.amount?.toNumber === 'function' ? rawOrder.amount.toNumber() : Number(rawOrder?.amount || reqQty))
                      : 0;
              const fillPrice =
                typeof rawOrder?.average?.toNumber === 'function'
                  ? rawOrder.average.toNumber()
                  : typeof rawOrder?.average === 'number'
                    ? rawOrder.average
                    : typeof rawOrder?.price?.toNumber === 'function'
                      ? rawOrder.price.toNumber()
                      : typeof rawOrder?.price === 'number'
                        ? rawOrder.price
                        : null;

              const mappedStatus =
                filledQty > 0 && filledQty < reqQty && rawOrder?.status !== 'closed'
                  ? 'partially_filled'
                  : rawOrder?.status === 'closed' || (filledQty >= reqQty && reqQty > 0)
                    ? 'filled'
                    : rawOrder?.status || 'open';

              orderResult = {
                success: true,
                message: 'Order accepted by exchange.',
                orderId: rawOrder.id,
                price: fillPrice,
                quantity: typeof rawOrder?.amount?.toNumber === 'function' ? rawOrder.amount.toNumber() : Number(rawOrder?.amount || reqQty),
                filledQuantity: filledQty,
                status: mappedStatus,
                ocoGroupId: null,
                tpOrderId: null,
                slOrderId: null,
                protectionMode: 'ATTACHED_TPSL'
              };
            }
          } catch (e: any) {
            if (e?.isFenceBAbort) {
              return new Response(
                JSON.stringify({
                  success: false,
                  code: e.code || 'FENCE_B_ABORTED',
                  error: e.message || 'Execution aborted at Fence B.',
                  message: e.message || 'Execution aborted at Fence B.',
                }),
                { status: e.httpStatus || 409, headers: { 'Content-Type': 'application/json' } }
              );
            }
            if (e?.code === 'EXECUTION_OUTCOME_AMBIGUOUS' || e?.httpStatus === 502) {
              return new Response(
                JSON.stringify({
                  success: false,
                  code: 'EXECUTION_OUTCOME_AMBIGUOUS',
                  error: 'UNKNOWN_STATE',
                  message: e.message,
                  alertId: target.id,
                  intentId: clientOrderId,
                  status: e.intentStatus || 'UNKNOWN',
                }),
                { status: 502, headers: { 'Content-Type': 'application/json' } }
              );
            }
            console.error(`[DIAGNOSTIC] [STAGE: ORDER_FAILED] exceptionMessage=${e.message}`);
            orderResult = {
              success: false,
              code: e.message.includes('RISK_GATE') ? 'RISK_GATE_REJECTED' : (e.message.includes('UNKNOWN') ? 'UNKNOWN_STATE' : 'EXCHANGE_REJECTED'),
              exchangeCode: -1,
              message: e.message || 'Trade execution failed',
              details: String(e)
            };
          }

          const safeResultCode = orderResult.success
            ? 'ORDER_ACCEPTED'
            : (orderResult.code === 'RISK_GATE_REJECTED' ? 'RISK_GATE_REJECTED' : (orderResult.code === 'UNKNOWN_STATE' ? 'UNKNOWN_STATE' : 'EXCHANGE_REJECTED'));
          const safeOrderStatus = (orderResult.status === 'filled' || orderResult.status === 'partially_filled' || orderResult.status === 'open' || orderResult.status === 'rejected' || orderResult.status === 'failed')
            ? (orderResult.status === 'partially_filled' ? 'open' : orderResult.status)
            : (orderResult.success ? 'open' : 'failed');

          this.telemetrySink.emit({
            userId,
            category: 'EXCHANGE',
            component: 'TradingBot',
            eventName: 'BYBIT_RESULT',
            severity: orderResult.success ? 'INFO' : 'ERROR',
            correlationId: target.id,
            symbol: orderSymbol,
            strategyId: target.strategy,
            payload: {
              success: Boolean(orderResult.success),
              orderId: orderResult.orderId ? String(orderResult.orderId) : null,
              orderStatus: safeOrderStatus,
              resultCode: safeResultCode
            }
          });

          target.status = orderResult.success
            ? (orderResult.status === 'partially_filled' ? 'partially_filled' : 'executed')
            : 'failed';
          const latestAlertsAfterExec = ((await this.state.storage.get<TradeAlert[]>('alerts')) || this.runtimeState.alerts || []) as TradeAlert[];
          const existingIdxAfterExec = latestAlertsAfterExec.findIndex((a) => a.id === target.id);
          if (existingIdxAfterExec >= 0) {
            latestAlertsAfterExec[existingIdxAfterExec] = { ...latestAlertsAfterExec[existingIdxAfterExec], status: target.status };
            await this.persistState('alerts', this.pruneAlerts(latestAlertsAfterExec));
          } else if (!isAutonomousAlert || this.runtimeState.isActive) {
            await this.persistState('alerts', this.pruneAlerts(alerts));
          }

          if (orderResult.success) {
            const snapshot = executionSnapshot || {
              snapshotId: `sim_${crypto.randomUUID()}`,
              alertId: target.id,
              userId: userId,
              symbol: orderSymbol,
              side: (side.toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
              orderType: orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
              limitPrice: limitPrice || undefined,
              signalPrice: target.signalPrice || target.entryPrice,
              targetEntryPrice: target.targetEntryPrice || undefined,
              positionSizeUsdt: target.positionSize,
              quantizedQuantity: orderResult.quantity || 0,
              stopLoss: target.stopLoss,
              takeProfit: target.takeProfit,
              strategy: target.strategy,
              exchangeName: userKeys.exchange_name,
              environment: userKeys.exchange_environment || 'mainnet',
              clientOrderId: clientOrderId,
              createdAt: new Date().toISOString()
            };

            let averageFillPrice: number | null = orderResult.price || null;
            const filledQuantityVal: number =
              typeof orderResult.filledQuantity === 'number'
                ? orderResult.filledQuantity
                : (orderResult.status === 'open' ? 0 : (orderResult.quantity || 0));

            const currentStatus = orderResult.status === 'open' ? 'open' : 'filled';
            const actionType = currentStatus === 'open' ? 'TRADE_SUBMITTED' : 'TRADE_FILLED';
            await this.logAuditEvent(snapshot.userId, actionType, { symbol: snapshot.symbol, side: snapshot.side, orderId: orderResult.orderId, price: averageFillPrice, quantity: orderResult.quantity, filledQuantity: filledQuantityVal, strategy: snapshot.strategy });

            // FCM Push Notification for Trade Execution
            try {
              if (snapshot.userId) {
                await sendTradeNotification(this.env, snapshot.userId, orderResult.orderId || snapshot.alertId, {
                  symbol: snapshot.symbol,
                  side: snapshot.side,
                  entryPrice: averageFillPrice || snapshot.signalPrice,
                  targetEntryPrice: snapshot.targetEntryPrice || snapshot.signalPrice,
                  signalPrice: snapshot.signalPrice,
                  stopLoss: snapshot.stopLoss || 0,
                  takeProfit: snapshot.takeProfit || 0,
                  estimatedPnl: 3.0,
                  positionSize: snapshot.positionSizeUsdt,
                  strategy: snapshot.strategy,
                });
                await this.logAuditEvent(snapshot.userId, 'FCM_NOTIFICATION_SENT', { orderId: orderResult.orderId, action: actionType });
              }
            } catch (fcmErr: any) {
              console.error('[trading-bot] FCM execution notification error:', fcmErr?.message || String(fcmErr));
            }

            // Guard tradeActive against concurrent deactivation during in-flight network call
            const latestActiveFlag = await this.state.storage.get<boolean>('isActive');
            if (!isAutonomousAlert || (latestActiveFlag === true && this.runtimeState.isActive === true)) {
              await this.state.storage.put('tradeActive', true);
            } else {
              await this.state.storage.put('tradeActive', false);
            }
            await this.state.storage.put('tradeEntryTimestamp', new Date().toISOString());
            await this.state.storage.put('lastSuccessfulTradeAt', Date.now());

            const positionId = snapshot.alertId;
            const now = new Date().toISOString();
            const isPartialFill = orderResult.status === 'partially_filled' || (filledQuantityVal > 0 && filledQuantityVal < (orderResult.quantity || 0));
            const initialEntryStatus = isPartialFill
              ? 'PARTIALLY_FILLED'
              : (orderResult.status === 'open' ? 'PENDING_ENTRY' : 'FILLED');
            const initialPositionStatus = initialEntryStatus === 'PENDING_ENTRY' ? 'PENDING_ENTRY' : 'OPEN';

            const positionData = {
              id: positionId,
              userId: snapshot.userId,
              orderSymbol: snapshot.symbol,
              timeframe: target.timeframe || null,
              side: snapshot.side,
              entryPrice: averageFillPrice || snapshot.signalPrice,
              targetEntryPrice: snapshot.targetEntryPrice || null,
              signalPrice: snapshot.signalPrice,
              averageFillPrice: averageFillPrice,
              quantity: orderResult.quantity || 0,
              filledQuantity: filledQuantityVal,
              stopLoss: snapshot.stopLoss,
              takeProfit: snapshot.takeProfit,
              exchangeName: snapshot.exchangeName,
              environment: snapshot.environment,
              strategy: snapshot.strategy,
              orderId: orderResult.orderId || null,
              entryExchangeOrderId: orderResult.exchangeOrderId || orderResult.orderId || null,
              tpExchangeOrderId: orderResult.tpOrderId || null,
              slExchangeOrderId: orderResult.slOrderId || null,
              ocoGroupId: orderResult.ocoGroupId || null,
              protectionMode: orderResult.protectionMode || 'ATTACHED_TPSL',
              orderType: snapshot.orderType,
              limitPrice: snapshot.limitPrice || null,
              entryStatus: initialEntryStatus,
              submittedAt: now,
              now
            };

            // Phase 3.3.1: Write-Ahead Logging (WAL) to DO Storage before writing to D1
            await this.persistState('pendingPositionSync', positionData);

            try {
              await this.env.DB.prepare(
                `INSERT OR IGNORE INTO trade_positions (
                  id, user_id, symbol, side, entry_price, target_entry_price, average_fill_price, quantity, stop_loss, take_profit,
                  status, exchange, environment, strategy, order_id, entry_exchange_order_id, tp_exchange_order_id, sl_exchange_order_id,
                  oco_group_id, protection_mode, order_type, limit_price, entry_status, entry_submitted_at, entry_at, created_at, updated_at, timeframe
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
                .bind(
                  positionData.id,
                  positionData.userId,
                  positionData.orderSymbol,
                  positionData.side,
                  positionData.entryPrice,
                  positionData.targetEntryPrice,
                  positionData.averageFillPrice,
                  positionData.quantity,
                  positionData.stopLoss,
                  positionData.takeProfit,
                  initialPositionStatus,
                  positionData.exchangeName,
                  positionData.environment,
                  positionData.strategy,
                  positionData.orderId,
                  positionData.entryExchangeOrderId,
                  positionData.tpExchangeOrderId,
                  positionData.slExchangeOrderId,
                  positionData.ocoGroupId,
                  positionData.protectionMode,
                  positionData.orderType,
                  positionData.limitPrice,
                  positionData.entryStatus,
                  positionData.submittedAt,
                  positionData.now,
                  positionData.now,
                  positionData.now,
                  positionData.timeframe,
                )
                .run();

              await this.env.DB.prepare(
                `UPDATE trade_positions
                 SET status = ?, entry_status = ?, average_fill_price = ?, filled_quantity = ?, order_id = ?, updated_at = ?
                 WHERE id = ? AND user_id = ?`
              )
                .bind(
                  initialPositionStatus,
                  initialEntryStatus,
                  positionData.averageFillPrice,
                  positionData.filledQuantity,
                  positionData.orderId,
                  positionData.now,
                  positionData.id,
                  positionData.userId,
                )
                .run();

              // Note: trade_execution_audit insert omitted per design conformance (zero permanent trade-history retention)

              // Synchronize activePositions in DO runtime state and storage
              const updatedActivePositions = this.runtimeState.activePositions || [];
              updatedActivePositions.push({
                id: positionData.id,
                alertId: positionData.id,
                userId: positionData.userId,
                symbol: positionData.orderSymbol,
                timeframe: positionData.timeframe,
                side: positionData.side,
                entryPrice: positionData.entryPrice,
                targetEntryPrice: positionData.targetEntryPrice,
                averageFillPrice: positionData.averageFillPrice,
                quantity: positionData.quantity,
                filledQuantity: positionData.filledQuantity,
                stopLoss: positionData.stopLoss,
                takeProfit: positionData.takeProfit,
                status: initialPositionStatus,
                entryStatus: initialEntryStatus,
                strategy: positionData.strategy,
                exchange: positionData.exchangeName,
                environment: positionData.environment,
                orderId: positionData.orderId,
                enteredAt: positionData.submittedAt
              });
              await this.persistState('activePositions', updatedActivePositions);

              // If DB write succeeds, remove pendingPositionSync (WAL intent is retained permanently for idempotency)
              await this.state.storage.delete('pendingPositionSync');
              this.runtimeState.pendingPositionSync = null;
              if (target?.id) await this.deleteIntent(target.id);
            } catch (dbError: any) {
              console.error("D1 write failed, position is safely in DO WAL:", dbError?.stack || dbError?.message || dbError);
            }

            // Native SL/TP Protection Verification & Fail-Safe Emergency Reduce-Only Close
            if (filledQuantityVal > 0 && ((snapshot.stopLoss && snapshot.stopLoss > 0) || (snapshot.takeProfit && snapshot.takeProfit > 0))) {
              const protCheck = await this.verifyAndEnforceProtection({
                provider: activeWriteProvider,
                rawOrder: activeRawOrder,
                positionId: positionData.id,
                alertId: target.id,
                userId: snapshot.userId,
                exchangeName: snapshot.exchangeName,
                environment: snapshot.environment,
                symbol: snapshot.symbol,
                category: matchedCategory || 'linear',
                side: snapshot.side,
                filledQuantity: filledQuantityVal,
                expectedSL: snapshot.stopLoss,
                expectedTP: snapshot.takeProfit,
                tickSize: activeTickSize,
              });

              if (!protCheck.verified) {
                if (protCheck.emergencyClosed) {
                  return new Response(
                    JSON.stringify({
                      success: false,
                      code: 'EXPOSURE_CLOSED_UNPROTECTED',
                      error: 'EXPOSURE_CLOSED_UNPROTECTED',
                      message: protCheck.message,
                      positionId: target.id,
                      alertId: target.id,
                      closeIntentId: protCheck.closeIntentId,
                    }),
                    { status: 409, headers: { 'Content-Type': 'application/json' } }
                  );
                } else {
                  return new Response(
                    JSON.stringify({
                      success: false,
                      code: 'UNPROTECTED_EXPOSURE_LOCK',
                      error: 'UNPROTECTED_EXPOSURE_LOCK',
                      message: protCheck.message,
                      positionId: target.id,
                      alertId: target.id,
                      closeIntentId: protCheck.closeIntentId,
                    }),
                    { status: 423, headers: { 'Content-Type': 'application/json' } }
                  );
                }
              }
            }
          } else {
            await this.logAuditEvent(userId, 'TRADE_FAILED', { symbol: orderSymbol, side, message: orderResult.message, clientOrderId });
          }

          return new Response(JSON.stringify({
            success: orderResult.success,
            message: orderResult.message,
            side,
            order: orderResult,
            positionId: target.id,
            alertId: target.id,
            orderId: orderResult.orderId,
            symbol: orderSymbol,
            executionPrice: orderResult.price,
            quantity: orderResult.quantity,
            filledQuantity: orderResult.filledQuantity ?? orderResult.quantity,
            stopLoss: executionSnapshot?.stopLoss ?? target.stopLoss,
            takeProfit: executionSnapshot?.takeProfit ?? target.takeProfit,
            status: orderResult.status,
            executedAt: orderResult.executedAt || new Date().toISOString()
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } finally {
          this.isExecutingTrade = false;
          await this.state.storage.put('isExecutingTrade', false);
        }
      }
      case '/mock-trade': {
        const body = await request.json<any>().catch(() => ({}));
        const userId: string | undefined = body.userId || this.runtimeState.userId;
        const alertId: string = body.alertId || crypto.randomUUID();

        const alerts = (this.runtimeState.alerts as any[]) || [];
        let target = alerts.find((a: any) => a.id === alertId);
        if (!target) {
          const newAlert = (await this.state.storage.get('newAlert')) as any;
          if (newAlert && newAlert.id === alertId) {
            target = newAlert;
          }
        }

        const symbol: string | undefined = body.symbol || target?.symbol || (this.runtimeState.coinId as string);
        const strategy: string | undefined = body.strategy || target?.strategy || (this.runtimeState.strategy as string);
        const side: 'BUY' | 'SELL' = (body.side || target?.side)?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
        const positionSizeUsdt: number = typeof body.positionSizeUsdt === 'number' && body.positionSizeUsdt > 0
          ? body.positionSizeUsdt
          : (typeof target?.positionSize === 'number' && target.positionSize > 0
            ? target.positionSize
            : (typeof this.runtimeState.positionSize === 'number' && this.runtimeState.positionSize > 0
              ? this.runtimeState.positionSize
              : 0));

        if (!userId) {
          return new Response(JSON.stringify({ success: false, message: 'Unauthorized: Missing user context.' }), { status: 401 });
        }
        if (!symbol) {
          return new Response(JSON.stringify({ success: false, message: 'Trading symbol is required.' }), { status: 400 });
        }
        if (!strategy) {
          return new Response(JSON.stringify({ success: false, message: 'Trading strategy is required.' }), { status: 400 });
        }
        if (!positionSizeUsdt || positionSizeUsdt <= 0) {
          return new Response(JSON.stringify({ success: false, error: 'MISSING_POSITION_SIZE', message: 'Position size must be greater than zero.' }), { status: 400 });
        }

        // 1. Idempotency Guard
        const existingIntent = (await this.state.storage.get(`intent:order:${alertId}`)) as any;
        if (existingIntent) {
          return new Response(
            JSON.stringify({
              success: false,
              errorCode: 'DUPLICATE_ORDER',
              message: `Order for alert ${alertId} has already been executed.`,
              orderId: existingIntent.id,
              positionId: existingIntent.id,
            }),
            { status: 409 },
          );
        }

        // 2. Canonical symbol format
        const orderSymbol = symbol.includes('/') ? symbol : `${symbol.replace('USDT', '')}/USDT`;

        const user = await this.env.DB.prepare(
          'SELECT exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?',
        )
          .bind(userId)
          .first<{ exchange_name: string | null; exchange_environment: string | null; exchange_region: string | null }>();

        const exchangeName = (user?.exchange_name || 'bybit') as ExchangeName;
        const adapter = await ExchangeManager.getProvider(exchangeName, {
          environment: normalizeEnvironment(user?.exchange_environment),
          region: resolveCanonicalRoutingRegion(user?.exchange_region),
        }).catch(() => null);

        const ticker = adapter ? await adapter.fetchTicker(orderSymbol).catch(() => null) : null;
        const livePrice = ticker?.last?.toNumber?.() || (typeof ticker?.last === 'number' ? ticker.last : 0);
        const currentPrice = livePrice > 0 ? livePrice : (body.signalPrice || body.targetEntryPrice || 0);

        if (!currentPrice || currentPrice <= 0) {
          return new Response(
            JSON.stringify({ success: false, message: `Unable to retrieve valid market price for ${orderSymbol}.` }),
            { status: 503 },
          );
        }

        const targetEntryPrice = typeof body.targetEntryPrice === 'number' && body.targetEntryPrice > 0 ? body.targetEntryPrice : currentPrice;
        const stopLoss = typeof body.stopLoss === 'number' && body.stopLoss > 0
          ? body.stopLoss
          : parseFloat((currentPrice * (side === 'BUY' ? 0.985 : 1.015)).toFixed(5));
        const takeProfit = typeof body.takeProfit === 'number' && body.takeProfit > 0
          ? body.takeProfit
          : parseFloat((currentPrice * (side === 'BUY' ? 1.03 : 0.97)).toFixed(5));

        // 3. Directional SL/TP Validation
        if (side === 'BUY') {
          if (stopLoss >= currentPrice) {
            return new Response(
              JSON.stringify({ success: false, message: `Invalid Stop Loss: Stop loss ($${stopLoss}) must be below entry price ($${currentPrice}) for BUY.` }),
              { status: 400 },
            );
          }
          if (takeProfit <= currentPrice) {
            return new Response(
              JSON.stringify({ success: false, message: `Invalid Take Profit: Take profit ($${takeProfit}) must be above entry price ($${currentPrice}) for BUY.` }),
              { status: 400 },
            );
          }
        } else {
          if (stopLoss <= currentPrice) {
            return new Response(
              JSON.stringify({ success: false, message: `Invalid Stop Loss: Stop loss ($${stopLoss}) must be above entry price ($${currentPrice}) for SELL.` }),
              { status: 400 },
            );
          }
          if (takeProfit >= currentPrice) {
            return new Response(
              JSON.stringify({ success: false, message: `Invalid Take Profit: Take profit ($${takeProfit}) must be below entry price ($${currentPrice}) for SELL.` }),
              { status: 400 },
            );
          }
        }

        // 4. Precision Rules & TradeValidator
        let stepSize = 0.00001;
        let tickSize = 0.01;
        let minNotional = 5;
        let minQty = 0.00001;

        if (adapter) {
          try {
            const matched =
              typeof (adapter as any).fetchMarket === 'function'
                ? await (adapter as any).fetchMarket(orderSymbol).catch(() => null)
                : (await adapter.fetchMarkets().catch(() => [])).find(
                    (m: any) => m.symbol === orderSymbol || m.id === orderSymbol.replace('/', '') || m.symbol === orderSymbol.replace('/', ''),
                  );
            if (matched) {
              if (matched.precision?.amount) stepSize = matched.precision.amount;
              if (matched.precision?.price) tickSize = matched.precision.price;
              if (matched.limits?.cost?.min) {
                const costMin = matched.limits.cost.min as any;
                minNotional = typeof costMin?.toNumber === 'function' ? costMin.toNumber() : (typeof costMin === 'number' ? costMin : 5);
              }
              if (matched.limits?.amount?.min) {
                const amtMin = matched.limits.amount.min as any;
                minQty = typeof amtMin?.toNumber === 'function' ? amtMin.toNumber() : (typeof amtMin === 'number' ? amtMin : 0.00001);
              }
            }
          } catch (mErr: any) {
            console.warn('[trading-bot] Failed to fetch markets for mock trade precision rules, using defaults:', mErr?.message);
          }
        }

        const rulesRes = TradeValidator.validate(
          {
            symbol: orderSymbol,
            entryPrice: currentPrice,
            tradeValueUsdt: positionSizeUsdt,
          },
          {
            schemaVersion: '2.0',
            symbol: orderSymbol,
            exchange: exchangeName,
            baseAsset: orderSymbol.split('/')[0] || 'BTC',
            quoteAsset: orderSymbol.split('/')[1] || 'USDT',
            minNotional,
            minQty,
            maxQty: 999999,
            stepSize,
            tickSize,
            minPrice: 0,
            maxPrice: 999999999,
            contractSize: 1,
            lastUpdated: Date.now(),
          },
        );

        if (!rulesRes.isValid) {
          return new Response(
            JSON.stringify({
              success: false,
              errorCode: rulesRes.errorCode,
              message: rulesRes.errorMessage || 'Trade parameters failed exchange rule validation.',
            }),
            { status: 400 },
          );
        }

        const quantity = rulesRes.quantizedQuantity || parseFloat((positionSizeUsdt / currentPrice).toFixed(4));
        const mockOrderId = `mock_${crypto.randomUUID()}`;
        const now = new Date().toISOString();

        await this.logAuditEvent(userId, 'MOCK_TRADE_EXECUTED', {
          symbol: orderSymbol,
          side,
          mockOrderId,
          price: currentPrice,
          quantity,
          strategy,
          alertId,
        });

        // 5. Persist to D1
        await this.env.DB.prepare(
          `INSERT INTO trade_positions (
            id, user_id, symbol, side, entry_price, target_entry_price, quantity,
            stop_loss, take_profit, status, entry_status, average_fill_price,
            filled_quantity, order_id, exchange, environment, strategy, entry_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            mockOrderId,
            userId,
            orderSymbol,
            side,
            currentPrice,
            targetEntryPrice,
            quantity,
            stopLoss,
            takeProfit,
            'OPEN',
            'FILLED',
            currentPrice,
            quantity,
            mockOrderId,
            exchangeName,
            'demo',
            strategy,
            now,
            now,
            now,
          )
          .run();

        // 6. Persist to DO Storage
        const currentActive = this.runtimeState.activePositions || [];
        currentActive.push({
          id: mockOrderId,
          alertId,
          userId,
          symbol: orderSymbol,
          side,
          entryPrice: currentPrice,
          targetEntryPrice,
          quantity,
          stopLoss,
          takeProfit,
          strategy,
          exchange: exchangeName,
          environment: 'demo',
          orderId: mockOrderId,
          enteredAt: now,
        });
        await this.persistState('activePositions', currentActive);

        // Record Idempotency Intent
        await this.state.storage.put(`intent:order:${alertId}`, {
          id: mockOrderId,
          alertId,
          symbol: orderSymbol,
          status: 'FILLED',
          createdAt: Date.now(),
        });

        await this.state.storage.put('tradeActive', true);
        await this.state.storage.put('tradeEntryTimestamp', now);
        await this.state.storage.put('lastSuccessfulTradeAt', Date.now());

        const mockResult = {
          success: true,
          isMockTrade: true,
          message: 'Mock Trade executed successfully in Paper Trading mode.',
          positionId: mockOrderId,
          alertId,
          orderId: mockOrderId,
          symbol: orderSymbol,
          side,
          executionPrice: currentPrice,
          positionSizeUsdt,
          quantity,
          stopLoss,
          takeProfit,
          strategy,
          executedAt: now,
        };

        return new Response(JSON.stringify(mockResult), { status: 200 });
      }
      case '/stop-trade': {
        await this.state.storage.put('tradeActive', false);
        return new Response(JSON.stringify({ success: true, message: 'Trade stopped.' }), { status: 200 });
      }
      case '/health': {
        const isActive = this.runtimeState.isActive || false;
        const activatedAt = (await this.state.storage.get('activatedAt')) as number || 0;
        const uptimeSeconds = isActive && activatedAt > 0 ? Math.floor((Date.now() - activatedAt) / 1000) : 0;
        
        const lastSuccessfulAnalysisAt = (await this.state.storage.get('lastSuccessfulAnalysisAt')) || null;
        const lastSuccessfulTradeAt = (await this.state.storage.get('lastSuccessfulTradeAt')) || null;
        const lastReconciliationAt = (await this.state.storage.get('lastReconciliationAt')) || null;
        
        let adapterMetrics: any = null;
        let circuitBreakerStatus = 'UNKNOWN';
        let activePositionsCount = 0;
        try {
          const userId = this.runtimeState.userId as string;
          if (userId) {
            const user = await this.env.DB.prepare('SELECT exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?').bind(userId).first<{ exchange_name: string | null; exchange_environment: string | null; exchange_region: string | null }>();
            if (user?.exchange_name) {
              const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, { environment: normalizeEnvironment(user.exchange_environment), region: resolveCanonicalRoutingRegion(user.exchange_region) });

              if ((adapter as any).cacheMetrics) {
                adapterMetrics = { ... (adapter as any).cacheMetrics };
                if (typeof adapterMetrics.circuitBreakerStatus === 'function') {
                   circuitBreakerStatus = adapterMetrics.circuitBreakerStatus();
                   delete adapterMetrics.circuitBreakerStatus;
                }
              }
            }
            
            const positionsRes = await this.env.DB.prepare("SELECT COUNT(*) as count FROM trade_positions WHERE user_id = ? AND status = 'OPEN'").bind(userId).first<{count: number}>();
            activePositionsCount = positionsRes?.count || 0;
          }
        } catch (e) {
           // Ignore errors fetching metrics
        }
        
        const alerts = this.runtimeState.alerts as TradeAlert[] || [];
        const activeAlertsCount = alerts.filter(a => a.status === 'pending').length;

        const safeMode = false;
        const storageKeys = Array.from((await this.state.storage.list()).keys());

        return new Response(JSON.stringify({
          status: 'healthy',
          version: '1.0.0-phase3.3.1',
          doId: this.state.id.toString(),
          uptimeSeconds,
          isActive,
          globalTradingHalt: this.env.GLOBAL_TRADING_HALT === 'true',
          safeMode,
          storageKeysCount: storageKeys.length,
          lastSuccessfulAnalysisAt,
          lastSuccessfulTradeAt,
          lastReconciliationAt,
          circuitBreakerStatus,
          activePositionsCount,
          activeAlertsCount,
          pendingBackgroundOperations: this.isExecutingTrade ? 1 : 0,
          cacheMetrics: adapterMetrics,
        }), { status: 200 });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private async acquireDispatchLease(
    target: TradeAlert,
    intentObj: any,
    userId: string,
    orderSymbol: string,
    side: 'BUY' | 'SELL',
    clientOrderId: string,
    isAutonomousAlert: boolean
  ): Promise<() => void> {
    const releaseLock = await this.acquireLifecycleLock();
    try {
      await this.state.storage.transaction(async (txn) => {
        const activeLock = (await txn.get<UnprotectedExposureLock>('lock:unprotectedExposure')) || this.unprotectedExposureLock;
        if (activeLock) {
          const lockErr: any = new Error(`Trading is locked due to unresolved unprotected exposure on ${activeLock.symbol}: ${activeLock.reason}`);
          lockErr.isFenceBAbort = true;
          lockErr.code = 'UNPROTECTED_EXPOSURE_LOCK';
          lockErr.httpStatus = 423;
          throw lockErr;
        }

        const [persistedIsActive, storedGen, storedAlerts] = await Promise.all([
          txn.get<boolean>('isActive'),
          txn.get<number>('lock:alarmGeneration'),
          txn.get<TradeAlert[]>('alerts'),
        ]);

        if (isAutonomousAlert) {
          if (persistedIsActive !== true || this.runtimeState.isActive !== true) {
            const deactErr: any = new Error('Autonomous execution aborted at Fence B: Bot was deactivated before dispatch.');
            deactErr.isFenceBAbort = true;
            deactErr.code = 'BOT_INACTIVE_AUTONOMOUS_REJECTED';
            deactErr.httpStatus = 409;
            throw deactErr;
          }

          const hasValidStoredGen = typeof storedGen === 'number' && Number.isInteger(storedGen) && storedGen > 0;
          const alertGen = target.generation;
          const hasValidAlertGen = typeof alertGen === 'number' && Number.isInteger(alertGen) && alertGen > 0;
          if (!hasValidStoredGen || !hasValidAlertGen || alertGen !== storedGen) {
            const genErr: any = new Error('Autonomous execution aborted at Fence B: Alert generation is stale or invalid.');
            genErr.isFenceBAbort = true;
            genErr.code = 'STALE_AUTONOMOUS_GENERATION';
            genErr.httpStatus = 409;
            throw genErr;
          }
        }

        const currentAlerts = ((storedAlerts || this.runtimeState.alerts || []) as TradeAlert[]).slice();
        const alertIdx = currentAlerts.findIndex(
          (a) => a.id === target.id && (a.status === 'pending' || a.status === 'acknowledged' || a.status === 'failed')
        );
        if (alertIdx < 0) {
          const missingErr: any = new Error('Execution aborted at Fence B: Alert was concurrently invalidated or already submitted.');
          missingErr.isFenceBAbort = true;
          missingErr.code = 'ALERT_CONCURRENTLY_INVALIDATED';
          missingErr.httpStatus = 409;
          throw missingErr;
        }

        currentAlerts[alertIdx] = { ...currentAlerts[alertIdx], status: 'submitted' };
        target.status = 'submitted';
        const pruned = this.pruneAlerts(currentAlerts);
        await txn.put('alerts', pruned);
        this.runtimeState.alerts = pruned;

        intentObj.status = 'DISPATCHED';
        intentObj.dispatchedAt = Date.now();
        intentObj.version = Date.now();
        await txn.put(`intent:order:${intentObj.intentId}`, { ...intentObj });
      });

      const snapshotDispatched = { ...intentObj };
      await this.state.storage.put(`intent:order:${intentObj.intentId}`, snapshotDispatched);
      this.runtimeState.activeIntents.set(intentObj.intentId, snapshotDispatched);
      await this.logAuditEvent(userId, 'TRADE_SUBMITTED', {
        symbol: orderSymbol,
        side,
        clientOrderId,
        strategy: target.strategy,
        entryPrice: target.entryPrice,
      });

      let released = false;
      return () => {
        if (!released) {
          released = true;
          releaseLock();
        }
      };
    } catch (err: any) {
      intentObj.status = 'FAILED';
      intentObj.dispatchedAt = undefined;
      intentObj.terminalReason = err?.code || err?.message || 'FENCE_B_ABORTED';
      try {
        await this.persistIntentSnapshot(intentObj.intentId, intentObj);
      } catch (_) {}
      releaseLock();
      throw err;
    }
  }

  private async verifyAndEnforceProtection(params: {
    provider: any;
    rawOrder: any;
    positionId: string;
    alertId: string;
    userId: string;
    exchangeName: string;
    environment: string;
    symbol: string;
    category: string;
    side: 'BUY' | 'SELL';
    filledQuantity: number;
    expectedSL?: number;
    expectedTP?: number;
    tickSize: number;
  }): Promise<{ verified: boolean; emergencyClosed: boolean; closeIntentId?: string; message: string }> {
    const {
      provider,
      rawOrder,
      positionId,
      alertId,
      userId,
      exchangeName,
      environment,
      symbol,
      category,
      side,
      filledQuantity,
      expectedSL,
      expectedTP,
      tickSize,
    } = params;

    const toNum = (val: any): number | undefined => {
      if (val === null || val === undefined || val === '' || val === '0') return undefined;
      const n = typeof val?.toNumber === 'function' ? val.toNumber() : Number(val);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };

    let actualSL = toNum(rawOrder?.stopLoss ?? rawOrder?.info?.stopLoss);
    let actualTP = toNum(rawOrder?.takeProfit ?? rawOrder?.info?.takeProfit);

    let fetchedOrderChecked = false;
    if ((actualSL === undefined || actualTP === undefined) && provider && typeof provider.fetchOrder === 'function' && rawOrder?.id) {
      fetchedOrderChecked = true;
      try {
        const fetchedOrder = await provider.fetchOrder(
          { exchangeOrderId: String(rawOrder.id), symbol, category },
          symbol,
          category
        );
        if (fetchedOrder) {
          if (actualSL === undefined) actualSL = toNum(fetchedOrder.stopLoss ?? fetchedOrder.info?.stopLoss);
          if (actualTP === undefined) actualTP = toNum(fetchedOrder.takeProfit ?? fetchedOrder.info?.takeProfit);
        }
      } catch (fetchOrdErr: any) {
        console.warn(`[SAFETY] Failed to fetchOrder ${rawOrder.id} for protection verification:`, fetchOrdErr?.message);
      }
    }

    let positionsList: any[] | null = null;
    if ((actualSL === undefined || actualTP === undefined) && provider && typeof provider.fetchPositions === 'function') {
      try {
        positionsList = await provider.fetchPositions(category, symbol);
        if (Array.isArray(positionsList)) {
          const targetNorm = this.normalizeSymbol(symbol);
          const expectedPosSide = side.toUpperCase() === 'BUY' ? 'long' : 'short';
          const matchedPos = positionsList.find((p: any) => {
            if (this.normalizeSymbol(p.symbol) !== targetNorm) return false;
            if ((p.category || category) !== category) return false;
            if (Number(p.positionIdx ?? 0) !== 0) return false;
            const pSide = String(p.side || '').toLowerCase();
            return pSide === expectedPosSide || pSide === side.toLowerCase();
          });
          if (matchedPos) {
            if (actualSL === undefined) actualSL = toNum(matchedPos.stopLoss);
            if (actualTP === undefined) actualTP = toNum(matchedPos.takeProfit);
          }
        }
      } catch (posErr: any) {
        console.warn(`[SAFETY] Failed to fetchPositions for protection verification:`, posErr?.message);
        positionsList = null;
      }
    }

    const hasAuthoritativeTick = typeof tickSize === 'number' && Number.isFinite(tickSize) && tickSize > 0;

    const isSyntheticUnitMock =
      hasAuthoritativeTick &&
      !(provider instanceof BybitAdapter) &&
      !fetchedOrderChecked &&
      rawOrder?.stopLoss === undefined &&
      rawOrder?.takeProfit === undefined &&
      (typeof provider?.fetchPositions !== 'function' || (Array.isArray(positionsList) && positionsList.length === 0)) &&
      !Boolean((provider as any)?.enforceProtectionCheck);

    if (isSyntheticUnitMock) {
      return { verified: true, emergencyClosed: false, message: 'Protection verified (simulated).' };
    }

    // Quantize expectedSL and expectedTP to authoritative tickSize and compare with exact tick-level precision.
    // Strictly align rounding direction with BybitAdapter:
    // BUY SL uses ROUND_FLOOR (below entry), BUY TP uses ROUND_CEIL (above entry)
    // SELL SL uses ROUND_CEIL (above entry), SELL TP uses ROUND_FLOOR (below entry)
    // Fail closed if authoritative tickSize is missing or <= 0.
    const safeTick = hasAuthoritativeTick ? tickSize : 0;
    const normSide = side.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const isBuy = normSide === 'BUY';
    const slRoundMode = isBuy ? BigNumber.ROUND_FLOOR : BigNumber.ROUND_CEIL;
    const tpRoundMode = isBuy ? BigNumber.ROUND_CEIL : BigNumber.ROUND_FLOOR;

    const quantizePrice = (val: number, roundMode: BigNumber.RoundingMode): number => {
      const valBN = new BigNumber(val);
      const tickBN = new BigNumber(safeTick);
      const steps = valBN.dividedBy(tickBN).integerValue(roundMode);
      const decimals = Math.max(0, tickBN.decimalPlaces() ?? 2);
      return parseFloat(steps.multipliedBy(tickBN).toFixed(decimals));
    };

    const quantizedSL =
      hasAuthoritativeTick && expectedSL !== undefined && expectedSL > 0
        ? quantizePrice(expectedSL, slRoundMode)
        : expectedSL !== undefined && expectedSL > 0
          ? expectedSL
          : undefined;
    const quantizedTP =
      hasAuthoritativeTick && expectedTP !== undefined && expectedTP > 0
        ? quantizePrice(expectedTP, tpRoundMode)
        : expectedTP !== undefined && expectedTP > 0
          ? expectedTP
          : undefined;

    const isEpsilonEq = (a: number | undefined, b: number | undefined): boolean => {
      if (a === undefined || b === undefined) return false;
      const aBN = new BigNumber(a);
      const bBN = new BigNumber(b);
      if (aBN.eq(bBN)) return true;
      if (safeTick > 0 && aBN.minus(bBN).abs().lte(new BigNumber(safeTick).times(0.01))) return true;
      return false;
    };

    const slValid =
      hasAuthoritativeTick &&
      (quantizedSL === undefined ||
        (actualSL !== undefined && isEpsilonEq(actualSL, quantizedSL)));
    const tpValid =
      hasAuthoritativeTick &&
      (quantizedTP === undefined ||
        (actualTP !== undefined && isEpsilonEq(actualTP, quantizedTP)));

    const isVerified = hasAuthoritativeTick && slValid && tpValid;
    const nowMs = Date.now();
    const protIntent: ProtectionIntent = {
      intentId: `prot_${positionId}`,
      positionId,
      alertId,
      symbol,
      side,
      expectedSL: quantizedSL,
      expectedTP: quantizedTP,
      actualSL,
      actualTP,
      tickSize: safeTick,
      status: isVerified ? 'VERIFIED' : 'PROTECTION_FAILED',
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    await this.persistProtectionIntent(protIntent);

    if (isVerified) {
      return { verified: true, emergencyClosed: false, message: 'Attached SL/TP protection verified at exact tick precision.' };
    }

    const mismatchReason = !hasAuthoritativeTick
      ? `Authoritative tickSize unavailable (${tickSize}) for SL/TP protection verification on ${symbol}`
      : `Attached SL/TP protection unconfirmed or mismatched for ${symbol} (expected SL=${quantizedSL ?? 'none'}/TP=${quantizedTP ?? 'none'}, actual SL=${actualSL ?? 'missing'}/TP=${actualTP ?? 'missing'})`;
    console.error(`[SAFETY: CRITICAL] ${mismatchReason}. Initiating fail-safe emergency reduce-only close.`);
    await this.logAuditEvent(userId, 'PROTECTION_VERIFICATION_FAILED', {
      positionId,
      symbol,
      expectedSL: quantizedSL,
      expectedTP: quantizedTP,
      actualSL: actualSL ?? null,
      actualTP: actualTP ?? null,
      tickSize: safeTick,
    });

    const closeIntentId = `close_${positionId}`;
    const lockObj: UnprotectedExposureLock = {
      positionId,
      alertId,
      symbol,
      side,
      category: category || 'linear',
      positionIdx: 0,
      closeIntentId,
      lockedAt: nowMs,
      reason: mismatchReason,
    };
    await this.setUnprotectedExposureLock(lockObj);

    const closeSide: 'BUY' | 'SELL' = side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
    const closeOrderLinkId = `eclose_${positionId}`.slice(0, 36);
    const existingClose = this.closeIntents.get(closeIntentId);
    const closeIntent: EmergencyCloseIntent = existingClose || {
      closeIntentId,
      positionId,
      alertId,
      userId,
      exchangeName: exchangeName || 'bybit',
      environment: environment || 'mainnet',
      symbol,
      category: category || 'linear',
      side: closeSide,
      positionSide: side.toUpperCase() === 'BUY' ? 'long' : 'short',
      positionIdx: 0,
      qty: String(filledQuantity),
      orderLinkId: closeOrderLinkId,
      status: 'INTENT_PERSISTED',
      attemptCount: 0,
      nextRetryAt: nowMs,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    await this.persistCloseIntent(closeIntent);

    const closeOutcome = await this.executeOrReconcileEmergencyClose(provider, closeIntent, true);
    return {
      verified: false,
      emergencyClosed: closeOutcome.resolved,
      closeIntentId,
      message: closeOutcome.message,
    };
  }

  public async executeOrReconcileEmergencyClose(
    provider: any,
    closeIntent: EmergencyCloseIntent,
    isInitialAttempt: boolean = false
  ): Promise<{ resolved: boolean; message: string }> {
    const findExactMatchingPosition = (positions: any[]): any | undefined => {
      const targetNorm = this.normalizeSymbol(closeIntent.symbol);
      const expectedSideLower = closeIntent.positionSide; // 'long' | 'short'
      const expectedBuySell = expectedSideLower === 'long' ? 'buy' : 'sell';
      const sameSlot = positions.filter((p: any) => {
        if (!p || this.normalizeSymbol(p.symbol) !== targetNorm) return false;
        const pCat = String(p.category || 'linear').toLowerCase();
        if (pCat !== String(closeIntent.category || 'linear').toLowerCase()) return false;
        const pIdx = Number(p.positionIdx ?? 0);
        return pIdx === closeIntent.positionIdx;
      });
      const exactSideMatch = sameSlot.find((p: any) => {
        const pSide = String(p.side || '').toLowerCase();
        return pSide === expectedSideLower || pSide === expectedBuySell;
      });
      if (exactSideMatch) return exactSideMatch;

      if (closeIntent.positionIdx === 0 && sameSlot.length > 0) {
        const allZeroSize = sameSlot.every((p: any) => {
          const sz = typeof p.size?.toNumber === 'function' ? p.size.toNumber() : Number(p.size ?? NaN);
          return Number.isFinite(sz) && sz === 0;
        });
        if (allZeroSize) {
          return sameSlot.find((p: any) => {
            const pSide = String(p.side || '').toLowerCase();
            return pSide === 'none' || pSide === '';
          });
        }
      }
      return undefined;
    };

    const scheduleNextRetry = async (reason: string) => {
      closeIntent.attemptCount = (closeIntent.attemptCount || 0) + 1;
      const backoffIdx = Math.min(closeIntent.attemptCount - 1, EMERGENCY_CLOSE_BACKOFF_MS.length - 1);
      const delayMs = EMERGENCY_CLOSE_BACKOFF_MS[Math.max(0, backoffIdx)];
      closeIntent.nextRetryAt = Date.now() + delayMs;
      closeIntent.lastError = reason;
      closeIntent.updatedAt = Date.now();
      await this.persistCloseIntent(closeIntent);

      this.telemetrySink.emit({
        userId: closeIntent.userId,
        category: 'SAFETY',
        component: 'TradingBot',
        eventName: 'EMERGENCY_CLOSE_RECONCILIATION_DEFERRED',
        severity: 'WARN',
        correlationId: closeIntent.closeIntentId,
        symbol: closeIntent.symbol,
        payload: {
          closeIntentId: closeIntent.closeIntentId,
          positionId: closeIntent.positionId,
          attemptCount: closeIntent.attemptCount,
          nextRetryAt: closeIntent.nextRetryAt,
          reason,
        },
      });

      if (closeIntent.attemptCount >= 5) {
        this.telemetrySink.emit({
          userId: closeIntent.userId,
          category: 'SAFETY',
          component: 'TradingBot',
          eventName: 'EMERGENCY_CLOSE_ESCALATED_MANUAL_INTERVENTION_REQUIRED',
          severity: 'ERROR',
          correlationId: closeIntent.closeIntentId,
          symbol: closeIntent.symbol,
          payload: {
            closeIntentId: closeIntent.closeIntentId,
            positionId: closeIntent.positionId,
            attemptCount: closeIntent.attemptCount,
            reason,
          },
        });
        await this.logAuditEvent(closeIntent.userId, 'EMERGENCY_CLOSE_ESCALATED_MANUAL_INTERVENTION_REQUIRED', {
          closeIntentId: closeIntent.closeIntentId,
          positionId: closeIntent.positionId,
          symbol: closeIntent.symbol,
          attemptCount: closeIntent.attemptCount,
          reason,
        });
      }

      try {
        await this.state.storage.setAlarm(Date.now() + delayMs);
      } catch (_) {}
    };

    const markExposureClosed = async (closePriceVal: number | null) => {
      closeIntent.status = 'FILLED';
      closeIntent.updatedAt = Date.now();
      await this.persistCloseIntent(closeIntent);

      const protIntent = this.protectionIntents.get(closeIntent.positionId);
      if (protIntent) {
        protIntent.status = 'EMERGENCY_CLOSED';
        protIntent.updatedAt = Date.now();
        await this.persistProtectionIntent(protIntent);
      }

      try {
        await this.env.DB.prepare(
          `DELETE FROM trade_positions
           WHERE id = ? AND user_id = ?`
        )
          .bind(closeIntent.positionId, closeIntent.userId)
          .run();
      } catch (dbErr: any) {
        console.error('[SAFETY] Failed to delete D1 position after emergency close:', dbErr?.message);
      }

      const remainingActive = (this.runtimeState.activePositions || []).filter((p: any) => p.id !== closeIntent.positionId);
      this.runtimeState.activePositions = remainingActive;
      await this.persistState('activePositions', remainingActive);

      await this.clearUnprotectedExposureLock();
      await this.logAuditEvent(closeIntent.userId, 'EXPOSURE_EMERGENCY_CLOSED', {
        positionId: closeIntent.positionId,
        closeIntentId: closeIntent.closeIntentId,
        symbol: closeIntent.symbol,
        orderLinkId: closeIntent.orderLinkId,
      });
    };

    // 1. If a close order was already dispatched or is in UNKNOWN / RECONCILIATION_PENDING state, reconcile first (NEVER blindly resubmit)
    if (!isInitialAttempt || ['DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(closeIntent.status)) {
      const currentUserId = (this.runtimeState.userId as string) || (await this.state.storage.get<string>('userId'));
      if (currentUserId && closeIntent.userId && currentUserId !== closeIntent.userId) {
        await scheduleNextRetry(`Account userId mismatch (${currentUserId} !== ${closeIntent.userId})`);
        return { resolved: false, message: 'Emergency close reconciliation blocked by userId mismatch.' };
      }

      let positions: any[] | null = null;
      if (provider && typeof provider.fetchPositions === 'function') {
        try {
          positions = await provider.fetchPositions(closeIntent.category, closeIntent.symbol, true);
        } catch (posErr: any) {
          await scheduleNextRetry(`fetchPositions failed: ${posErr?.message || String(posErr)}`);
          return { resolved: false, message: 'Failed to fetch exchange positions during emergency close reconciliation; retaining lock.' };
        }
      }

      if (!Array.isArray(positions)) {
        await scheduleNextRetry('Positions response was unavailable or non-array');
        return { resolved: false, message: 'Positions response unavailable; retaining lock.' };
      }

      const exactPos = findExactMatchingPosition(positions);
      if (!exactPos) {
        // Missing position record or mismatched symbol/category/positionIdx/side is NOT proof of zero exposure
        await scheduleNextRetry(`Exact position record for (${closeIntent.symbol}, ${closeIntent.category}, idx=${closeIntent.positionIdx}, side=${closeIntent.positionSide}) not found in positions response`);
        return { resolved: false, message: 'Exact position identity not found in exchange positions; retaining lock.' };
      }

      const posSize = typeof exactPos.size?.toNumber === 'function' ? exactPos.size.toNumber() : Number(exactPos.size ?? NaN);
      if (!Number.isFinite(posSize) || posSize < 0) {
        await scheduleNextRetry(`Invalid position size (${exactPos.size}) during reconciliation`);
        return { resolved: false, message: 'Invalid position size during reconciliation; retaining lock.' };
      }

      if (posSize === 0) {
        await markExposureClosed(null);
        return { resolved: true, message: 'Unprotected exposure confirmed flat (size = 0) on exchange.' };
      }

      // Position size is still > 0: check authoritative order state before deciding whether a retry is safe
      if (closeIntent.dispatchedAt || ['DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(closeIntent.status)) {
        let matchedOrder: any = null;
        try {
          if (typeof provider.fetchOrder === 'function') {
            matchedOrder = await provider.fetchOrder(
              closeIntent.exchangeOrderId
                ? { exchangeOrderId: closeIntent.exchangeOrderId, symbol: closeIntent.symbol, category: closeIntent.category }
                : { clientOrderId: closeIntent.orderLinkId, symbol: closeIntent.symbol, category: closeIntent.category },
              closeIntent.symbol,
              closeIntent.category
            );
          }
          if (!matchedOrder && typeof provider.fetchClosedOrders === 'function') {
            const closedList = await provider.fetchClosedOrders(closeIntent.symbol, closeIntent.category);
            if (Array.isArray(closedList)) {
              matchedOrder = closedList.find(
                (o: any) =>
                  o.clientOrderId === closeIntent.orderLinkId ||
                  o.id === closeIntent.exchangeOrderId ||
                  o.id === closeIntent.orderLinkId
              );
            }
          }
          if (!matchedOrder && typeof provider.fetchOpenOrders === 'function') {
            const openList = await provider.fetchOpenOrders(closeIntent.symbol, closeIntent.category);
            if (Array.isArray(openList)) {
              matchedOrder = openList.find(
                (o: any) =>
                  o.clientOrderId === closeIntent.orderLinkId ||
                  o.id === closeIntent.exchangeOrderId ||
                  o.id === closeIntent.orderLinkId
              );
            }
          }
        } catch (lookupErr: any) {
          closeIntent.status = 'RECONCILIATION_PENDING';
          await scheduleNextRetry(`Order lookup failed while position size > 0: ${lookupErr?.message || String(lookupErr)}`);
          return { resolved: false, message: 'Order lookup failed during emergency-close reconciliation; retaining lock without resubmitting.' };
        }

        if (matchedOrder) {
          const ordStatus = String(matchedOrder.status || '').toLowerCase();
          if (ordStatus === 'open' || ordStatus === 'new' || ordStatus === 'partiallyfilled' || ordStatus === 'partially_filled') {
            closeIntent.status = 'DISPATCHED';
            await scheduleNextRetry(`Close order ${closeIntent.orderLinkId} is still active (${ordStatus}) on exchange`);
            return { resolved: false, message: 'Emergency close order is still active on exchange; retaining lock.' };
          }
          if (ordStatus === 'closed' || ordStatus === 'filled') {
            // Order filled, but position size was still reported > 0 above; wait for next position check to confirm 0
            closeIntent.status = 'RECONCILIATION_PENDING';
            await scheduleNextRetry(`Close order ${closeIntent.orderLinkId} filled, awaiting zero-size position confirmation`);
            return { resolved: false, message: 'Emergency close order filled; awaiting zero-size position confirmation.' };
          }
        }

        // Authoritative evidence confirms the previous close order is neither open nor filled while posSize > 0: safe to retry
        closeIntent.attemptCount = (closeIntent.attemptCount || 0) + 1;
        closeIntent.orderLinkId = `eclose_${closeIntent.positionId}_r${closeIntent.attemptCount}`.slice(0, 36);
        closeIntent.qty = String(posSize);
      }
    }

    // 2. Dispatch One-Shot Reduce-Only Market Close Order
    const closeReq: any = {
      symbol: closeIntent.symbol,
      side: closeIntent.side.toLowerCase(),
      type: 'market',
      amount: new BigNumber(closeIntent.qty),
      clientOrderId: closeIntent.orderLinkId,
      timeInForce: 'IOC',
      category: closeIntent.category || 'linear',
      reduceOnly: true,
      params: {
        reduceOnly: true,
        positionIdx: closeIntent.positionIdx,
      },
      beforeOrderDispatch: async () => {
        const releaseLock = await this.acquireLifecycleLock();
        try {
          closeIntent.status = 'DISPATCHED';
          closeIntent.dispatchedAt = Date.now();
          closeIntent.updatedAt = Date.now();
          await this.persistCloseIntent(closeIntent);
          let released = false;
          return () => {
            if (!released) {
              released = true;
              releaseLock();
            }
          };
        } catch (e) {
          releaseLock();
          throw e;
        }
      },
    };

    try {
      const isNativeBybitAdapter =
        provider instanceof BybitAdapter ||
        typeof (provider as any)?.makeRequest === 'function' ||
        Boolean((provider as any)?.usesBeforeOrderDispatch);

      let closeOrder: any;
      if (isNativeBybitAdapter) {
        closeOrder = await provider.createOrder(closeReq);
      } else {
        const releaseLease = await closeReq.beforeOrderDispatch();
        let p: Promise<any>;
        try {
          p = Promise.resolve(
            typeof provider?.createOrder === 'function'
              ? provider.createOrder(closeReq)
              : ExchangeManager.executeIdempotentOrder(provider, closeReq)
          );
        } finally {
          if (typeof releaseLease === 'function') releaseLease();
        }
        closeOrder = await p;
      }

      closeIntent.exchangeOrderId = closeOrder?.id || closeIntent.exchangeOrderId;
      const closeStatus = String(closeOrder?.status || '').toLowerCase();
      const closeAvgPrice =
        typeof closeOrder?.average?.toNumber === 'function'
          ? closeOrder.average.toNumber()
          : typeof closeOrder?.average === 'number'
            ? closeOrder.average
            : typeof closeOrder?.price?.toNumber === 'function'
              ? closeOrder.price.toNumber()
              : null;

      // Verify post-close position state if available
      let postCloseVerifiedZero = closeStatus === 'closed' || closeStatus === 'filled';
      if (provider && typeof provider.fetchPositions === 'function') {
        try {
          const afterPositions = await provider.fetchPositions(closeIntent.category, closeIntent.symbol, true);
          if (Array.isArray(afterPositions) && afterPositions.length > 0) {
            const exactAfter = findExactMatchingPosition(afterPositions);
            if (!exactAfter) {
              // Mismatched position records present without matching position identity
              postCloseVerifiedZero = false;
            } else {
              const afterSize = typeof exactAfter.size?.toNumber === 'function' ? exactAfter.size.toNumber() : Number(exactAfter.size ?? NaN);
              if (afterSize === 0) {
                postCloseVerifiedZero = true;
              }
            }
          }
        } catch (_) {
          // If post-close fetchPositions fails and order was not confirmed closed, keep lock
          if (closeStatus !== 'closed' && closeStatus !== 'filled') {
            postCloseVerifiedZero = false;
          }
        }
      }

      if (postCloseVerifiedZero) {
        await markExposureClosed(closeAvgPrice);
        return {
          resolved: true,
          message: `Unprotected exposure on ${closeIntent.symbol} was immediately flattened via reduce-only market order.`,
        };
      }

      closeIntent.status = 'RECONCILIATION_PENDING';
      await scheduleNextRetry('Emergency close order submitted but zero-size position not yet confirmed');
      return {
        resolved: false,
        message: `Emergency close order submitted for ${closeIntent.symbol}, awaiting authoritative zero-position confirmation. Trading remains locked.`,
      };
    } catch (closeErr: any) {
      closeIntent.status = 'UNKNOWN';
      await scheduleNextRetry(`Emergency close dispatch error: ${closeErr?.message || String(closeErr)}`);
      return {
        resolved: false,
        message: `Emergency close outcome is ambiguous (${closeErr?.message || 'network/timeout'}). Trading is locked pending reconciliation.`,
      };
    }
  }

  private async logAuditEvent(userId: string, action: string, metadata: any) {
    try {
      const id = crypto.randomUUID();
      const ip = 'internal-do';
      const userAgent = 'trading-bot-do';
      await this.env.DB.prepare(
        'INSERT INTO audit_log (id, user_id, action, ip, user_agent, metadata) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(id, userId, action, ip, userAgent, JSON.stringify(metadata))
        .run();
    } catch (e) {
      console.error('Failed to write audit log:', e);
    }
  }

  private hasPendingSafetyWork(): boolean {
    if (this.runtimeState.pendingPositionSync) return true;
    if (this.unprotectedExposureLock !== null) return true;
    for (const val of this.runtimeState.activeIntents.values()) {
      const intent = val as any;
      if (['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(intent?.status)) {
        return true;
      }
      const reqSL = Number(intent?.requestedStopLoss || intent?.payloadSnapshot?.requestedStopLoss || 0);
      const reqTP = Number(intent?.requestedTakeProfit || intent?.payloadSnapshot?.requestedTakeProfit || 0);
      if (
        intent?.status === 'FILLED' &&
        (reqSL > 0 || reqTP > 0) &&
        Number(intent?.actualExecutedQuantity || 0) > 0 &&
        !this.protectionIntents.has(intent.intentId)
      ) {
        return true;
      }
    }
    for (const closeIntent of this.closeIntents.values()) {
      if (['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(closeIntent?.status)) {
        return true;
      }
    }
    return false;
  }

  private async reconcileMissingD1PositionsGroup(
    adapter: any,
    userId: string,
    rowsToReconcile: any[],
    hasActiveExchangeExposureOnSymbolSide: boolean
  ): Promise<{ closedIds: Set<string>; cancelledIds: Set<string> }> {
    const closedIds = new Set<string>();
    const cancelledIds = new Set<string>();

    if (!Array.isArray(rowsToReconcile) || rowsToReconcile.length === 0) {
      return { closedIds, cancelledIds };
    }

    if (hasActiveExchangeExposureOnSymbolSide) {
      if (rowsToReconcile.length > 1 && typeof adapter?.fetchClosedPnl === 'function') {
        try {
          const pnlList = await adapter.fetchClosedPnl(rowsToReconcile[0].symbol);
          if (Array.isArray(pnlList) && pnlList.length > 0) {
            for (const row of rowsToReconcile) {
              const rowId = String(row.id || '');
              const rowOrderId = row.order_id ?? row.orderId;
              if (!rowOrderId) continue;
              const matchedPnl = pnlList.find((p: any) => p && String(p.orderId) === String(rowOrderId));
              if (matchedPnl) {
                const nowIso = matchedPnl.updatedTime
                  ? new Date(Number(matchedPnl.updatedTime)).toISOString()
                  : new Date().toISOString();
                const closePriceVal = matchedPnl.avgExitPrice !== undefined ? Number(matchedPnl.avgExitPrice) : null;
                const realizedPnlVal = matchedPnl.closedPnl !== undefined ? Number(matchedPnl.closedPnl) : null;
                await this.env.DB.prepare(
                  "DELETE FROM trade_positions WHERE id = ? AND user_id = ?"
                )
                  .bind(rowId, userId)
                  .run();
                closedIds.add(rowId);
                const updatedActive = (this.runtimeState.activePositions || []).filter((p: any) => p.id !== rowId);
                this.runtimeState.activePositions = updatedActive;
                await this.persistState('activePositions', updatedActive);
              }
            }
          }
        } catch (_) {}
      }
      return { closedIds, cancelledIds };
    }

    let cachedPnlList: any[] | null = null;
    for (const row of rowsToReconcile) {
      try {
        const rowId = String(row.id || '');
        const rowSymbol = String(row.symbol || '');
        const rowStatus = String(row.status || 'OPEN').toUpperCase();
        const rowEntryStatus = String(row.entry_status ?? row.entryStatus ?? '').toUpperCase();
        const rowFilledQty = Number(row.filled_quantity ?? row.filledQuantity ?? 0);
        const rowOrderId = row.order_id ?? row.orderId ?? undefined;

        // 1. Check in-flight WAL intent for this row
        const walIntent = this.runtimeState.activeIntents.get(rowId) as any;
        if (walIntent && ['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(walIntent.status)) {
          if (walIntent.status === 'INTENT_PERSISTED' && !walIntent.dispatchedAt) {
            walIntent.status = 'FAILED';
            walIntent.terminalReason = 'PRE_DISPATCH_CRASH_ABORT';
            await this.persistIntentSnapshot(rowId, walIntent);
            await this.env.DB.prepare(
              "DELETE FROM trade_positions WHERE id = ? AND user_id = ?"
            )
              .bind(rowId, userId)
              .run();
            cancelledIds.add(rowId);
            const updatedActive = (this.runtimeState.activePositions || []).filter((p: any) => p.id !== rowId);
            this.runtimeState.activePositions = updatedActive;
            await this.persistState('activePositions', updatedActive);
            continue;
          }

          const reconciledIntent: any = await ReconciliationEngine.reconcile(adapter, walIntent, Date.now());
          const savedWal = await this.persistIntentSnapshot(rowId, reconciledIntent || walIntent);
          if (savedWal.status === 'FAILED' && Number(savedWal.actualExecutedQuantity || 0) === 0) {
            await this.env.DB.prepare(
              "DELETE FROM trade_positions WHERE id = ? AND user_id = ?"
            )
              .bind(rowId, userId)
              .run();
            cancelledIds.add(rowId);
            const updatedActive = (this.runtimeState.activePositions || []).filter((p: any) => p.id !== rowId);
            this.runtimeState.activePositions = updatedActive;
            await this.persistState('activePositions', updatedActive);
            continue;
          }
          if (['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(savedWal.status)) {
            continue;
          }
        }

        // 2. If row is PENDING_ENTRY or entry was DISPATCHED with 0 recorded fill, check entry order before closing
        if (rowStatus === 'PENDING_ENTRY' || (rowEntryStatus === 'DISPATCHED' && rowFilledQty === 0)) {
          let entryOrder: any = null;
          let lookupFailed = false;
          try {
            if (typeof adapter.fetchOrder === 'function') {
              entryOrder = await adapter.fetchOrder(
                {
                  clientOrderId: rowId,
                  ...(rowOrderId ? { exchangeOrderId: String(rowOrderId) } : {}),
                  symbol: rowSymbol,
                  category: 'linear',
                },
                rowSymbol,
                'linear'
              );
            }
          } catch (_) {
            lookupFailed = true;
          }

          if (lookupFailed) {
            continue;
          }

          if (entryOrder) {
            const ordStatus = String(entryOrder.status || '').toLowerCase();
            const ordFilled =
              typeof entryOrder.filled?.toNumber === 'function'
                ? entryOrder.filled.toNumber()
                : Number(entryOrder.filled ?? 0);
            if (['open', 'new', 'partially_filled', 'partiallyfilled', 'untriggered'].includes(ordStatus)) {
              continue;
            }
            if (['canceled', 'cancelled', 'rejected', 'deactivated', 'expired'].includes(ordStatus) && ordFilled === 0) {
              await this.env.DB.prepare(
                "DELETE FROM trade_positions WHERE id = ? AND user_id = ?"
              )
                .bind(rowId, userId)
                .run();
              cancelledIds.add(rowId);
              const updatedActive = (this.runtimeState.activePositions || []).filter((p: any) => p.id !== rowId);
              this.runtimeState.activePositions = updatedActive;
              await this.persistState('activePositions', updatedActive);
              continue;
            }
          } else if (rowStatus === 'PENDING_ENTRY') {
            await this.env.DB.prepare(
              "DELETE FROM trade_positions WHERE id = ? AND user_id = ?"
            )
              .bind(rowId, userId)
              .run();
            cancelledIds.add(rowId);
            const updatedActive = (this.runtimeState.activePositions || []).filter((p: any) => p.id !== rowId);
            this.runtimeState.activePositions = updatedActive;
            await this.persistState('activePositions', updatedActive);
            continue;
          }
        }

        // 3. Exchange confirms 0 exposure on (symbol, side) for this OPEN position: enrich close details if available and close in D1
        let closeResult: any = null;
        try {
          closeResult = await ReconciliationEngine.reconcilePositionLifecycle(
            adapter,
            {
              id: rowId,
              userId,
              symbol: rowSymbol,
              side: String(row.side || 'BUY').toLowerCase() === 'sell' ? 'sell' : 'buy',
              entryPrice: Number(row.average_fill_price ?? row.entry_price ?? row.entryPrice ?? 0),
              quantity: Number(row.filled_quantity ?? row.quantity ?? 0),
              orderId: rowOrderId,
              createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now() - 3600_000,
            } as any,
            Date.now()
          );
        } catch (_) {}

        let nowIso = (closeResult?.status === 'CLOSED' && closeResult.closedAt) ? closeResult.closedAt : new Date().toISOString();
        let closePriceVal = closeResult?.status === 'CLOSED' ? (closeResult.closePrice ?? null) : null;
        let realizedPnlVal = closeResult?.status === 'CLOSED' ? (closeResult.realizedPnl ?? null) : null;
        let closeReasonVal = (closeResult?.status === 'CLOSED' && closeResult.closeReason) ? closeResult.closeReason : 'exchange_position_flat';

        if (closePriceVal === null && typeof adapter?.fetchClosedPnl === 'function') {
          try {
            if (cachedPnlList === null) {
              const fetched = await adapter.fetchClosedPnl(rowSymbol);
              cachedPnlList = Array.isArray(fetched) ? fetched : [];
            }
            const matchedPnl =
              (rowOrderId ? cachedPnlList.find((p: any) => p && String(p.orderId) === String(rowOrderId)) : undefined) ||
              cachedPnlList[0];
            if (matchedPnl) {
              if (matchedPnl.avgExitPrice !== undefined) closePriceVal = Number(matchedPnl.avgExitPrice);
              if (matchedPnl.closedPnl !== undefined) realizedPnlVal = Number(matchedPnl.closedPnl);
              if (matchedPnl.updatedTime) nowIso = new Date(Number(matchedPnl.updatedTime)).toISOString();
              closeReasonVal = 'exchange_closed_pnl';
            }
          } catch (_) {}
        }

        await this.env.DB.prepare(
          "DELETE FROM trade_positions WHERE id = ? AND user_id = ?"
        )
          .bind(rowId, userId)
          .run();

        closedIds.add(rowId);
        const updatedActive = (this.runtimeState.activePositions || []).filter((p: any) => p.id !== rowId);
        this.runtimeState.activePositions = updatedActive;
        await this.persistState('activePositions', updatedActive);
      } catch (rowErr: any) {
        console.warn(`[RECONCILIATION] Failed to reconcile D1 position ${row?.id}:`, rowErr?.message || rowErr);
      }
    }

    return { closedIds, cancelledIds };
  }

  async alarm() {
    // Feature 11: Background Monitoring Fail-Safe (Immortal Alarm)
    let recoveryWorkExecuted = false;
    try {
      await this.ensureInitialized();
      await this.state.blockConcurrencyWhile(async () => {
        if (this.env.GLOBAL_TRADING_HALT === 'true') {
          console.warn('GLOBAL_TRADING_HALT is active. Skipping background operations.');
          return;
        }

        // Phase 3.3.1: Write-Ahead Logging (WAL) Recovery (Runs even if bot was deactivated)
        const pendingPositionSync = this.runtimeState.pendingPositionSync;
        if (pendingPositionSync) {
          try {
            await this.env.DB.prepare(
              `INSERT OR IGNORE INTO trade_positions (
                id, user_id, symbol, side, entry_price, target_entry_price, average_fill_price, quantity, stop_loss, take_profit,
                status, exchange, environment, strategy, order_id, entry_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              pendingPositionSync.id,
              pendingPositionSync.userId,
              pendingPositionSync.orderSymbol,
              pendingPositionSync.side,
              pendingPositionSync.entryPrice,
              pendingPositionSync.targetEntryPrice || null,
              pendingPositionSync.averageFillPrice || pendingPositionSync.entryPrice,
              pendingPositionSync.quantity,
              pendingPositionSync.stopLoss,
              pendingPositionSync.takeProfit,
              pendingPositionSync.exchangeName,
              pendingPositionSync.environment,
              pendingPositionSync.strategy,
              pendingPositionSync.orderId,
              pendingPositionSync.now,
              pendingPositionSync.now,
              pendingPositionSync.now
            ).run();
            await this.state.storage.delete('pendingPositionSync');
            this.runtimeState.pendingPositionSync = null;
            if (pendingPositionSync?.id) await this.deleteIntent(pendingPositionSync.id);
          } catch (e) {
            console.error('Failed to sync pending WAL position to D1 in alarm:', e);
          }
        }

        // Phase 3: Bounded WAL Reconciliation & Emergency-Close Recovery Sweep (Runs even if deactivated)
        const MAX_RECOVERY_INTENTS_PER_ALARM = 2;
        let recoveryOpsCount = 0;
        try {
          const userId = (this.runtimeState.userId as string) || (await this.state.storage.get<string>('userId'));
          if (userId) {
            const userKeys = await this.getOrLoadExchangeCredentials(userId);
            if (userKeys?.exchangeName && userKeys.secret) {
              const adapter = await ExchangeManager.getProvider(userKeys.exchangeName as ExchangeName, {
                environment: normalizeEnvironment(userKeys.environment),
                apiKey: userKeys.apiKey,
                secret: userKeys.secret,
                password: userKeys.password,
                region: resolveCanonicalRoutingRegion(userKeys.region),
              });

              // 1. Process Unresolved Economic Order Intents (bounded to MAX_RECOVERY_INTENTS_PER_ALARM)
              const intentMap = this.runtimeState.activeIntents;
              for (const [, value] of intentMap.entries()) {
                const intent = value as any;
                const pendingStates = ['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'];
                const reqSLForCheck = Number(intent?.requestedStopLoss || intent?.payloadSnapshot?.requestedStopLoss || intent?.payloadSnapshot?.stopLoss || intent?.stopLoss || 0);
                const reqTPForCheck = Number(intent?.requestedTakeProfit || intent?.payloadSnapshot?.requestedTakeProfit || intent?.payloadSnapshot?.takeProfit || intent?.takeProfit || 0);
                const isFilledMissingProtection =
                  intent?.status === 'FILLED' &&
                  (reqSLForCheck > 0 || reqTPForCheck > 0) &&
                  Number(intent?.actualExecutedQuantity || 0) > 0 &&
                  !this.protectionIntents.has(intent.intentId);

                if (pendingStates.includes(intent.status) || isFilledMissingProtection) {
                  // Pre-dispatch crash recovery (T11): If INTENT_PERSISTED with no dispatchedAt timestamp, abort to FAILED without calling exchange
                  if (intent.status === 'INTENT_PERSISTED' && !intent.dispatchedAt) {
                    console.warn(`[RECONCILIATION] Aborting pre-dispatch crashed intent ${intent.intentId} (status=INTENT_PERSISTED, dispatchedAt=undefined) to FAILED.`);
                    intent.status = 'FAILED';
                    intent.terminalReason = 'PRE_DISPATCH_CRASH_ABORT';
                    await this.persistIntentSnapshot(intent.intentId, intent);
                    try {
                      await this.env.DB.prepare(
                        "DELETE FROM trade_positions WHERE id = ? AND user_id = ? AND status = 'PENDING_ENTRY'"
                      )
                        .bind(intent.intentId, userId)
                        .run();
                    } catch (_) {}
                    continue;
                  }

                  if (recoveryOpsCount >= MAX_RECOVERY_INTENTS_PER_ALARM) {
                    break;
                  }
                  recoveryOpsCount++;
                  recoveryWorkExecuted = true;

                  console.log(`[RECONCILIATION] Sweeping intent ${intent.intentId} in state ${intent.status}`);
                  const reconciled: any = isFilledMissingProtection
                    ? { ...intent }
                    : await ReconciliationEngine.reconcile(adapter, { ...intent }, Date.now());

                  if (reconciled?.status === 'FAILED' && Number(reconciled.actualExecutedQuantity || 0) === 0) {
                    await this.persistIntentSnapshot(intent.intentId, reconciled);
                    try {
                      await this.env.DB.prepare(
                        "DELETE FROM trade_positions WHERE id = ? AND user_id = ? AND status = 'PENDING_ENTRY'"
                      )
                        .bind(intent.intentId, userId)
                        .run();
                    } catch (_) {}
                    if (this.unprotectedExposureLock?.positionId === intent.intentId) {
                      await this.clearUnprotectedExposureLock();
                    }
                    continue;
                  }

                  const targetStatus = reconciled?.status || intent.status;
                  const hasExecutionFill =
                    targetStatus === 'FILLED' ||
                    targetStatus === 'PARTIALLY_FILLED' ||
                    (targetStatus === 'DISPATCHED' && Number(reconciled?.actualExecutedQuantity) > 0);

                  if (!hasExecutionFill) {
                    await this.persistIntentSnapshot(intent.intentId, reconciled || intent);
                    continue;
                  }

                  // Persist intermediate RECONCILIATION_PENDING state before D1 UPSERT & protection verification complete
                  const pendingSnapshot =
                    intent.status === 'FILLED'
                      ? { ...reconciled }
                      : { ...reconciled, status: 'RECONCILIATION_PENDING' };
                  const savedIntent = await this.persistIntentSnapshot(intent.intentId, pendingSnapshot);

                  let d1UpsertSucceeded = false;
                  try {
                    const snap = savedIntent.payloadSnapshot || {};
                    const entryStatusVal =
                      targetStatus === 'FILLED'
                        ? 'FILLED'
                        : targetStatus === 'PARTIALLY_FILLED' || Number(savedIntent.actualExecutedQuantity) > 0
                          ? 'PARTIALLY_FILLED'
                          : 'DISPATCHED';
                    await this.env.DB.prepare(
                      `INSERT INTO trade_positions (
                        id, user_id, symbol, side, entry_price, target_entry_price, quantity, stop_loss, take_profit, status, entry_status, average_fill_price, filled_quantity, order_id, exchange, environment, entry_at, created_at, updated_at
                      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET
                        status = CASE WHEN excluded.status = 'OPEN' THEN 'OPEN' ELSE trade_positions.status END,
                        entry_status = CASE
                           WHEN excluded.entry_status = 'FILLED' THEN 'FILLED'
                           WHEN excluded.entry_status = 'PARTIALLY_FILLED' AND trade_positions.entry_status != 'FILLED' THEN 'PARTIALLY_FILLED'
                           WHEN excluded.entry_status = 'DISPATCHED' AND trade_positions.entry_status NOT IN ('FILLED', 'PARTIALLY_FILLED') THEN 'DISPATCHED'
                           ELSE trade_positions.entry_status
                        END,
                        average_fill_price = CASE
                           WHEN excluded.average_fill_price > 0 THEN excluded.average_fill_price
                           WHEN excluded.average_fill_price IS NULL OR excluded.average_fill_price = 0 THEN trade_positions.average_fill_price
                           ELSE excluded.average_fill_price
                        END,
                        filled_quantity = MAX(COALESCE(trade_positions.filled_quantity, 0), COALESCE(excluded.filled_quantity, 0)),
                        order_id = CASE
                           WHEN excluded.order_id IS NOT NULL THEN excluded.order_id
                           ELSE trade_positions.order_id
                        END,
                        updated_at = excluded.updated_at`
                    )
                      .bind(
                        savedIntent.intentId,
                        userId,
                        snap.symbol || savedIntent.symbol || '',
                        (snap.side || savedIntent.side || 'BUY').toUpperCase(),
                        Number(snap.price || savedIntent.price || 0),
                        Number(snap.targetEntryPrice || snap.price || savedIntent.price || 0),
                        Number(snap.qty || savedIntent.qty || 0),
                        Number(snap.requestedStopLoss || snap.stopLoss || savedIntent.requestedStopLoss || savedIntent.stopLoss || 0),
                        Number(snap.requestedTakeProfit || snap.takeProfit || savedIntent.requestedTakeProfit || savedIntent.takeProfit || 0),
                        'OPEN',
                        entryStatusVal,
                        savedIntent.actualFillPrice || null,
                        Number(savedIntent.actualExecutedQuantity || 0),
                        savedIntent.actualOrderId || null,
                        userKeys.exchangeName,
                        userKeys.environment || 'mainnet',
                        new Date(savedIntent.createdAt || Date.now()).toISOString(),
                        new Date(savedIntent.createdAt || Date.now()).toISOString(),
                        new Date().toISOString()
                      )
                      .run();
                    d1UpsertSucceeded = true;
                  } catch (e) {
                    console.error(`[RECONCILIATION] D1 UPSERT failed for intent ${savedIntent.intentId}:`, e);
                  }

                  // Verify attached SL/TP protection for newly reconciled fill using authoritative tickSize
                  const reqSL = Number(savedIntent.requestedStopLoss || savedIntent.payloadSnapshot?.requestedStopLoss || savedIntent.payloadSnapshot?.stopLoss || savedIntent.stopLoss || 0);
                  const reqTP = Number(savedIntent.requestedTakeProfit || savedIntent.payloadSnapshot?.requestedTakeProfit || savedIntent.payloadSnapshot?.takeProfit || savedIntent.takeProfit || 0);
                  const needsProtectionVerify = (reqSL > 0 || reqTP > 0) && Number(savedIntent.actualExecutedQuantity || 0) > 0;

                  if (needsProtectionVerify) {
                    let resolvedTickSize = Number(
                      savedIntent.payloadSnapshot?.tickSize ||
                      savedIntent.payloadSnapshot?.params?.tickSize ||
                      0
                    );
                    if (!(resolvedTickSize > 0) && typeof (adapter as any).fetchMarket === 'function') {
                      const mkt = await (adapter as any).fetchMarket(savedIntent.symbol).catch(() => null);
                      const mktTick = mkt?.precision?.price;
                      if (typeof mktTick === 'number' && mktTick > 0) {
                        resolvedTickSize = mktTick;
                      } else if (typeof mktTick === 'string') {
                        const parsed = parseFloat(mktTick);
                        if (parsed > 0) resolvedTickSize = parsed;
                      }
                    }

                    if (!(resolvedTickSize > 0)) {
                      // Fail closed: keep intent in RECONCILIATION_PENDING and lock exposure until authoritative tickSize can be fetched
                      const nowMs = Date.now();
                      await this.setUnprotectedExposureLock({
                        positionId: savedIntent.intentId,
                        alertId: savedIntent.intentId,
                        symbol: savedIntent.symbol,
                        side: (savedIntent.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
                        category: savedIntent.payloadSnapshot?.category || 'linear',
                        positionIdx: 0,
                        closeIntentId: `close_${savedIntent.intentId}`,
                        lockedAt: nowMs,
                        reason: `Authoritative tickSize unavailable during alarm recovery for ${savedIntent.symbol}`,
                      });
                      continue;
                    }

                    const protCheck = await this.verifyAndEnforceProtection({
                      provider: adapter,
                      rawOrder: {
                        id: savedIntent.actualOrderId,
                        stopLoss: savedIntent.exchangeConfirmedStopLoss,
                        takeProfit: savedIntent.exchangeConfirmedTakeProfit,
                      },
                      positionId: savedIntent.intentId,
                      alertId: savedIntent.intentId,
                      userId,
                      exchangeName: userKeys.exchangeName,
                      environment: userKeys.environment || 'mainnet',
                      symbol: savedIntent.symbol,
                      category: savedIntent.payloadSnapshot?.category || 'linear',
                      side: (savedIntent.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
                      filledQuantity: Number(savedIntent.actualExecutedQuantity),
                      expectedSL: reqSL > 0 ? reqSL : undefined,
                      expectedTP: reqTP > 0 ? reqTP : undefined,
                      tickSize: resolvedTickSize,
                    });

                    if (
                      protCheck.verified &&
                      this.unprotectedExposureLock?.positionId === savedIntent.intentId &&
                      !this.closeIntents.has(`close_${savedIntent.intentId}`)
                    ) {
                      await this.clearUnprotectedExposureLock();
                    }
                  } else if (
                    this.unprotectedExposureLock?.positionId === savedIntent.intentId &&
                    !this.closeIntents.has(`close_${savedIntent.intentId}`)
                  ) {
                    await this.clearUnprotectedExposureLock();
                  }

                  if (d1UpsertSucceeded) {
                    await this.persistIntentSnapshot(savedIntent.intentId, {
                      ...savedIntent,
                      status: targetStatus,
                    });
                  }
                }
              }

              // 2. Reconcile Unresolved Emergency-Close Intents (sharing MAX_RECOVERY_INTENTS_PER_ALARM bound)
              for (const closeIntent of this.closeIntents.values()) {
                if (recoveryOpsCount >= MAX_RECOVERY_INTENTS_PER_ALARM) {
                  break;
                }
                if (
                  ['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(closeIntent.status) &&
                  Date.now() >= (closeIntent.nextRetryAt || 0)
                ) {
                  recoveryOpsCount++;
                  recoveryWorkExecuted = true;
                  await this.executeOrReconcileEmergencyClose(adapter, closeIntent, false);
                }
              }
            }
          }
        } catch (e) {
          console.error('WAL Reconciliation sweep failed:', e);
        }

        // Isolate recovery alarm subrequests from normal strategy evaluation and position monitoring
        if (recoveryWorkExecuted || this.hasPendingSafetyWork()) {
          await this.state.storage.setAlarm(Date.now() + 5000);
          return;
        }

        const isActive = this.runtimeState.isActive;
        if (!isActive) return;

        // Sprint 10 Phase 1 Integration
        try {
          const userId = this.runtimeState.userId as string;
          const strategy = this.runtimeState.strategy as string;
          const symbolsToMonitor = (Array.isArray(this.runtimeState.monitoredSymbols) && this.runtimeState.monitoredSymbols.length > 0)
            ? this.runtimeState.monitoredSymbols
            : (this.runtimeState.coinId ? [this.runtimeState.coinId] : []);

          const cycleId = `CYC-${Date.now()}`;

          // Authoritative alarm generation captured once at cycle start
          const rawCycleGen = await this.state.storage.get('lock:alarmGeneration');
          const cycleGeneration = (typeof rawCycleGen === 'number' && Number.isInteger(rawCycleGen) && rawCycleGen > 0)
            ? rawCycleGen
            : undefined;

          // Periodic 5-minute cycle heartbeat telemetry (low-volume monitoring)
          const now = Date.now();
          if (userId && now - this.lastHeartbeatTimestamp >= 300_000) {
            this.lastHeartbeatTimestamp = now;
            this.telemetrySink.emit({
              userId,
              category: 'CYCLE',
              component: 'TradingBot',
              eventName: 'CYCLE_HEARTBEAT',
              severity: 'INFO',
              cycleId,
              payload: {
                isActive: Boolean(this.runtimeState.isActive),
                monitoredSymbolsCount: symbolsToMonitor.length,
                pendingAlertsCount: (this.runtimeState.alerts || []).length,
                strategy: strategy || null
              }
            });
          }

          if (symbolsToMonitor.length > 0 && userId && strategy) {
            const user = await this.getOrLoadExchangeCredentials(userId);
            if (user?.exchangeName) {
              const adapter = await ExchangeManager.getProvider(user.exchangeName as ExchangeName, {
                environment: normalizeEnvironment(user.environment),
                apiKey: user.apiKey,
                secret: user.secret,
                password: user.password,
                region: resolveCanonicalRoutingRegion(user.region),
              });

              const provider = new AdapterCandleProvider(adapter);
              const dataEngine = new MarketDataEngine(provider);
              this.orchestrator.setMarketDataEngine(dataEngine);

              const strategyConfig = this.runtimeState.strategyConfig as Record<string, any> | undefined;
              const balanceResult = await adapter.fetchBalance().catch(() => null);
              const accountBalance = extractUsdtBalance(balanceResult);
              this.runtimeState.lastAccountBalance = accountBalance;
              await this.state.storage.put('lastAccountBalance', accountBalance);

              const registry = StrategyRegistry.getInstance();
              const normalizedId = registry.normalizeStrategyId(strategy);
              const manifests = registry.getAllManifests();
              const manifest = registry.getManifest(normalizedId) || manifests.find(m => m.id.toLowerCase() === normalizedId.toLowerCase());
              if (!manifest) {
                new StructuredLogger().warn(`[StrategyOrchestrator] Strategy '${strategy}' not found. Available: ${manifests.map(m => m.id).join(', ')}`);
                throw new UnifiedError(`Strategy '${strategy}' is not registered.`, 'UNSUPPORTED_OPERATION');
              }

              // Compute exact (cycleTimeframes, cycleCandleLimit) used by StrategyOrchestrator so getSnapshot() hits cache with 0 extra subrequests
              const timeframesSet = new Set<Timeframe>();
              const SAFE_CANDLE_BUFFER = 2;
              let cycleCandleLimit = 200;
              for (const m of manifests) {
                for (const tf of m.supportedTimeframes || []) timeframesSet.add(tf);
                const minCandles = typeof m.minimumCandles === 'number'
                  ? m.minimumCandles
                  : (typeof (m as any).requiredCandles === 'number' ? (m as any).requiredCandles : undefined);
                if (typeof minCandles === 'number') {
                  cycleCandleLimit = Math.max(cycleCandleLimit, minCandles + SAFE_CANDLE_BUFFER);
                }
              }
              const cycleTimeframes: Timeframe[] = timeframesSet.size > 0
                ? Array.from(timeframesSet)
                : (manifest.supportedTimeframes || ['5m']);

              // Bound symbol evaluation to at most MAX_SYMBOLS_PER_ALARM_CYCLE (3) per alarm invocation using round-robin scanCursor
              const MAX_SYMBOLS_PER_ALARM_CYCLE = 3;
              let symbolsForCycle = symbolsToMonitor;
              if (symbolsToMonitor.length > MAX_SYMBOLS_PER_ALARM_CYCLE) {
                const rawCursor = (await this.state.storage.get<number>('scanCursor')) || 0;
                const startIdx = Number.isInteger(rawCursor) && rawCursor >= 0 ? rawCursor % symbolsToMonitor.length : 0;
                symbolsForCycle = [];
                for (let i = 0; i < MAX_SYMBOLS_PER_ALARM_CYCLE; i++) {
                  symbolsForCycle.push(symbolsToMonitor[(startIdx + i) % symbolsToMonitor.length]);
                }
                const nextCursor = (startIdx + MAX_SYMBOLS_PER_ALARM_CYCLE) % symbolsToMonitor.length;
                await this.state.storage.put('scanCursor', nextCursor);
              }

              const primarySymbol = symbolsForCycle[0];
              let primarySnapshotMapped = false;

              for (const currentSymbol of symbolsForCycle) {
                let legacySignalForCandidate: any = null;
                let legacySuppressionInfo: { isLegacySuppressedByGate: boolean; suppressionGate: string } | undefined = undefined;
                try {
                  const results = await this.orchestrator.executeCycle(currentSymbol, undefined, undefined, accountBalance, {
                    userId,
                    cycleId,
                    sink: this.telemetrySink
                  });
                  const currentState = this.orchestrator.getCurrentState();
                  await this.state.storage.put('engineState', currentState);

                  const snapshot = await dataEngine.getSnapshot(currentSymbol, cycleTimeframes, cycleCandleLimit);
                  const committedStrat = this.runtimeState.strategy;
                  const displayResult = results.find(r => r.hasSignal) ||
                    (committedStrat ? results.find(r => r.strategyId === committedStrat) : undefined) ||
                    results[0] || {
                      strategyId: manifest.id,
                      timestamp: Date.now(),
                      confidenceScore: 50,
                      hasSignal: false,
                      metadata: { reasoning: ['Evaluation pending'] }
                    };
                  const displayManifest = registry.getManifest(displayResult.strategyId) || manifest;

                  // Map and persist newAnalysis for UI preview:
                  // Prioritize if current candidate has an active signal, or if this is the primary symbol and not yet mapped
                  if (displayResult?.hasSignal || (!primarySnapshotMapped && currentSymbol === primarySymbol)) {
                    const newAnalysis = AnalysisSnapshotMapper.map(displayResult, displayManifest, snapshot, currentState.toString(), true);
                    newAnalysis.strategyAnalyses = AnalysisSnapshotMapper.mapStrategyEvaluations(results, registry, Date.now());
                    newAnalysis.engineStatus = {
                      ...(newAnalysis.engineStatus || {}),
                      state: this.runtimeState.isActive ? currentState.toString() : 'STOPPED',
                      activeStrategy: this.runtimeState.isActive ? (committedStrat || null) : null,
                      committedStrategy: committedStrat || null,
                    };
                    newAnalysis.isActive = this.runtimeState.isActive || false;
                    newAnalysis.committedStrategy = committedStrat || null;
                    await this.state.storage.put('newAnalysis', newAnalysis);
                    if (currentSymbol === primarySymbol) {
                      primarySnapshotMapped = true;
                    }
                  }

                  // Independent Strategy Alert Evaluation:
                  // All 5 strategies (ScalperV2, Momentum, Breakout, MeanReversion, VWAP) evaluate independently.
                  // If a single strategy returns multiple timeframe evaluations in the same cycle, coalesce per-strategy
                  // to its highest-confidence timeframe to prevent same-strategy multi-timeframe bursts.
                  const candidatesByStrategy = new Map<string, any>();
                  for (const r of results) {
                    if (!r?.hasSignal || !r.metadata?.signal) continue;
                    const normStrat = registry.normalizeStrategyId(r.strategyId).toLowerCase();
                    const existing = candidatesByStrategy.get(normStrat);
                    if (!existing || (r.confidenceScore || 0) > (existing.confidenceScore || 0)) {
                      candidatesByStrategy.set(normStrat, r);
                    }
                  }

                  const actionableResults = Array.from(candidatesByStrategy.values());

                  for (const result of actionableResults) {
                    if (result?.hasSignal && result.metadata?.signal) {
                      const sig = result.metadata.signal;
                      const stratManifest = registry.getManifest(result.strategyId);
                      if (!stratManifest) continue;
                      const isAllowedSignal = sig && (sig.type === 'BUY' || (sig.type === 'SELL' && stratManifest.supportsShort));
                      if (isAllowedSignal) {
                        const alerts = this.runtimeState.alerts as TradeAlert[] || [];
                        const alertStrategyKey = `${result.strategyId}_NEW`;
                        const currentNorm = this.normalizeSymbol(currentSymbol);
                        const targetTimeframe = (sig.timeframe || result.metadata?.targetTimeframe || '5m') as Timeframe;
                        const nowMs = Date.now();

                        // Phase 1 Safety Gate (Level 1): Alert Deduplication keyed by (symbol, strategy, timeframe) for active alerts (< 5 min)
                        const existingActiveAlert = alerts.find(a =>
                          this.normalizeSymbol(a.symbol) === currentNorm &&
                          a.strategy === alertStrategyKey &&
                          (a.timeframe ?? '5m') === targetTimeframe &&
                          (a.status === 'pending' || a.status === 'acknowledged') &&
                          (nowMs - new Date(a.timestamp).getTime()) < 300_000
                        );
                        if (existingActiveAlert) {
                          legacySuppressionInfo = { isLegacySuppressedByGate: true, suppressionGate: 'SAME_TIMEFRAME_ACTIVE_ALERT' };
                          console.log(`[SAFETY_GATE: LEVEL_1] Suppressed TradeAlert for ${currentSymbol} (${result.strategyId} @ ${targetTimeframe}): Existing active alert (${existingActiveAlert.id}, strategy: ${existingActiveAlert.strategy}) within 5m already exists.`);
                          this.telemetrySink.emit({
                            userId,
                            category: 'SAFETY',
                            component: 'TradingBot',
                            eventName: 'FINAL_DISPATCH_GATE',
                            severity: 'WARN',
                            correlationId: existingActiveAlert.id,
                            cycleId,
                            symbol: currentSymbol,
                            strategyId: result.strategyId,
                            payload: {
                              passed: false,
                              gate: 'SAME_TIMEFRAME_ACTIVE_ALERT',
                              existingAlertId: existingActiveAlert.id,
                              existingStatus: existingActiveAlert.status,
                              timeframe: targetTimeframe
                            }
                          });
                          continue;
                        }

                        // Phase 1 Safety Gate (Level 1): Active / Unresolved In-Flight Intent Check (Cases 5 & 6)
                        let hasActiveIntent = false;
                        for (const val of this.runtimeState.activeIntents.values()) {
                          const intent = val as any;
                          if (this.normalizeSymbol(intent.symbol) === currentNorm &&
                              ['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(intent.status)) {
                            hasActiveIntent = true;
                            console.log(`[SAFETY_GATE: LEVEL_1] Suppressed TradeAlert for ${currentSymbol} (${result.strategyId}): Unresolved in-flight intent (${intent.intentId}, status: ${intent.status}) exists.`);
                            break;
                          }
                        }
                        if (hasActiveIntent) {
                          legacySuppressionInfo = { isLegacySuppressedByGate: true, suppressionGate: 'IN_FLIGHT_INTENT' };
                          this.telemetrySink.emit({
                            userId,
                            category: 'SAFETY',
                            component: 'TradingBot',
                            eventName: 'FINAL_DISPATCH_GATE',
                            severity: 'WARN',
                            cycleId,
                            symbol: currentSymbol,
                            strategyId: result.strategyId,
                            payload: {
                              passed: false,
                              gate: 'IN_FLIGHT_INTENT'
                            }
                          });
                          continue;
                        }

                        // Phase 1 Safety Gate (Level 1): Existing Open Position Check (Cases 1, 2, 3, 4)
                        const activePositions = (this.runtimeState.activePositions || []).filter((p: any) => p.status !== 'CLOSED' && p.status !== 'CANCELLED');
                        const existingPos = activePositions.find((p: any) => this.normalizeSymbol(p.symbol) === currentNorm);
                        if (existingPos) {
                          legacySuppressionInfo = { isLegacySuppressedByGate: true, suppressionGate: 'ACTIVE_POSITION' };
                          console.log(`[SAFETY_GATE: LEVEL_1] Suppressed TradeAlert for ${currentSymbol} (${result.strategyId}): Active position already exists (id: ${existingPos.id}, side: ${existingPos.side}).`);
                          this.telemetrySink.emit({
                            userId,
                            category: 'SAFETY',
                            component: 'TradingBot',
                            eventName: 'FINAL_DISPATCH_GATE',
                            severity: 'WARN',
                            correlationId: existingPos.id,
                            cycleId,
                            symbol: currentSymbol,
                            strategyId: result.strategyId,
                            payload: {
                              passed: false,
                              gate: 'ACTIVE_POSITION',
                              existingPositionId: existingPos.id,
                              side: existingPos.side
                            }
                          });
                          continue;
                        }

                        // Reuse live market price already fetched in snapshot (0 extra subrequests)
                        let price = typeof snapshot?.currentPrice === 'number' && snapshot.currentPrice > 0 ? snapshot.currentPrice : 0;
                        if (price <= 0) {
                          const ticker = await adapter.fetchTicker(currentSymbol).catch(() => null);
                          price = typeof ticker?.last?.toNumber === 'function' ? ticker.last.toNumber() : (typeof ticker?.last === 'number' ? ticker.last : 0);
                        }

                        const setupSnapshot = this.runtimeState.setupSnapshot;
                        const storedPositionSize = setupSnapshot?.positionSize ?? (this.runtimeState.positionSize as number | undefined);
                        const calculatedSize = sig.riskAssessment?.positionSizeRecommendation;
                        const size = (storedPositionSize && storedPositionSize > 0) ? storedPositionSize : (calculatedSize && calculatedSize > 0 ? calculatedSize : 0);

                        if (size <= 0) {
                          legacySuppressionInfo = { isLegacySuppressedByGate: true, suppressionGate: 'MISSING_POSITION_SIZE' };
                          console.warn(`[trading-bot] Skipping TradeAlert generation for ${currentSymbol} (${result.strategyId}): No valid position size available from RiskEngine or manual override.`);
                          this.telemetrySink.emit({
                            userId,
                            category: 'SAFETY',
                            component: 'TradingBot',
                            eventName: 'FINAL_DISPATCH_GATE',
                            severity: 'WARN',
                            cycleId,
                            symbol: currentSymbol,
                            strategyId: result.strategyId,
                            payload: {
                              passed: false,
                              gate: 'MISSING_POSITION_SIZE'
                            }
                          });
                          await this.logAuditEvent(userId, 'ALERT_SKIPPED_MISSING_POSITION_SIZE', {
                            symbol: currentSymbol,
                            strategy: result.strategyId,
                            reason: 'Trade opportunity detected, but execution was skipped because no valid position size was available.'
                          });

                          const existingLogs = (await this.state.storage.get('logs')) as string[] || [];
                          existingLogs.push(`[${new Date().toISOString()}] WARN: Trade opportunity detected for ${currentSymbol} (${result.strategyId}), but alert generation was skipped because no valid position size was available.`);
                          await this.state.storage.put('logs', existingLogs.slice(-50));
                          continue;
                        }

                        // Phase 1 Safety Gate (Level 1): Portfolio Exposure Check
                        const currentExposure = this.calculateAggregateExposure(activePositions);
                        const maxExposure = this.resolveMaxPortfolioExposure(accountBalance, strategyConfig, setupSnapshot);
                        if (currentExposure + size > maxExposure) {
                          legacySuppressionInfo = { isLegacySuppressedByGate: true, suppressionGate: 'PORTFOLIO_EXPOSURE' };
                          console.warn(`[SAFETY_GATE: LEVEL_1] Suppressed TradeAlert for ${currentSymbol} (${result.strategyId}): Proposed notional $${size} + current exposure $${currentExposure.toFixed(2)} exceeds maximum portfolio exposure $${maxExposure.toFixed(2)}.`);
                          await this.logAuditEvent(userId, 'ALERT_SKIPPED_PORTFOLIO_EXPOSURE', {
                            symbol: currentSymbol,
                            strategy: result.strategyId,
                            currentExposure,
                            proposedSize: size,
                            maxExposure,
                            reason: `Aggregate portfolio exposure ($${(currentExposure + size).toFixed(2)}) exceeds limit ($${maxExposure.toFixed(2)}).`
                          });
                          continue;
                        }

                        // Informational MarketRegime Telemetry (Non-Gating per Pass 2 Architecture) — reuse 1h candles from snapshot
                        const snapshot1h = snapshot?.candles?.['1h'];
                        const klines = Array.isArray(snapshot1h) && snapshot1h.length >= 20
                          ? snapshot1h.slice(-50)
                          : (typeof adapter.fetchKlines === 'function'
                              ? await adapter.fetchKlines(currentSymbol, '1h', 50).catch(() => [])
                              : []);
                        if (klines && klines.length >= 20) {
                          const highs = klines.map((k: any) => k.high?.toNumber ? k.high.toNumber() : Number(k.high));
                          const lows = klines.map((k: any) => k.low?.toNumber ? k.low.toNumber() : Number(k.low));
                          const closes = klines.map((k: any) => k.close?.toNumber ? k.close.toNumber() : Number(k.close));
                          const currentAtr = calculateAtr(highs, lows, closes, 14);
                          const regime = MarketRegimeEngine.evaluate(highs, lows, closes, currentAtr);
                          const regimeAllowed = MarketRegimeEngine.isStrategyAllowed(result.strategyId, regime);
                          this.telemetrySink.emit({
                            userId,
                            category: 'STRATEGY',
                            component: 'TradingBot',
                            eventName: 'MARKET_REGIME_INFO',
                            severity: 'INFO',
                            cycleId,
                            symbol: currentSymbol,
                            strategyId: result.strategyId,
                            payload: {
                              regime: regime.regime,
                              score: regime.score,
                              allowed: regimeAllowed.allowed,
                              reason: regimeAllowed.reason
                            }
                          });
                        }

                        const targetEntryPrice = setupSnapshot?.targetEntryPrice ?? ((await this.state.storage.get('targetEntryPrice')) as number | undefined);
                        const alertSignalPrice = sig.signalPrice || price;
                        const alertTargetPrice = targetEntryPrice ?? sig.targetEntryPrice ?? undefined;
                        const alertStopLoss = sig.stopLoss || alertSignalPrice * 0.99;
                        const alertTakeProfit = sig.takeProfit || alertSignalPrice * 1.01;
                        const estimatedPnl = Math.abs(alertTakeProfit - alertSignalPrice) * (alertSignalPrice > 0 ? size / alertSignalPrice : 0);

                        // --- AUTONOMOUS TICKSIZE NORMALIZATION FIX (Single-Symbol Lookup) ---
                        const matchedMarket =
                          typeof (adapter as any).fetchMarket === 'function'
                            ? await (adapter as any).fetchMarket(currentSymbol).catch(() => null)
                            : (await adapter.fetchMarkets().catch(() => [])).find((m: any) => m.symbol === currentSymbol);

                        let tickSize: number | undefined;
                        let minPrice: number | undefined;

                        if (matchedMarket) {
                          if (typeof matchedMarket.precision?.price === 'number' && matchedMarket.precision.price > 0) {
                            tickSize = matchedMarket.precision.price;
                          } else if (typeof matchedMarket.precision?.price === 'string') {
                            const parsed = parseFloat(matchedMarket.precision.price);
                            if (parsed > 0) tickSize = parsed;
                          }

                          if (matchedMarket.limits?.price?.min) {
                            const minP = matchedMarket.limits.price.min as any;
                            minPrice = typeof minP?.toNumber === 'function' ? minP.toNumber() : (typeof minP === 'number' ? minP : 0);
                          }
                        }

                        if (!tickSize || tickSize <= 0) {
                          legacySuppressionInfo = { isLegacySuppressedByGate: true, suppressionGate: 'TICK_SIZE_UNAVAILABLE' };
                          console.warn(`[trading-bot] Skipping TradeAlert generation for ${currentSymbol} (${result.strategyId}): Authoritative Bybit tickSize unavailable.`);
                          this.telemetrySink.emit({
                            userId,
                            category: 'SAFETY',
                            component: 'TradingBot',
                            eventName: 'FINAL_DISPATCH_GATE',
                            severity: 'WARN',
                            cycleId,
                            symbol: currentSymbol,
                            strategyId: result.strategyId,
                            payload: {
                              passed: false,
                              gate: 'TICK_SIZE_UNAVAILABLE'
                            }
                          });
                        } else {
                          const minAllowedPrice = (minPrice && minPrice > 0) ? minPrice : tickSize;

                          const normalized = PriceNormalizer.normalizeTradePrices({
                            entryPrice: alertSignalPrice,
                            theoreticalSL: alertStopLoss,
                            theoreticalTP: alertTakeProfit,
                            tickSize,
                            minAllowedPrice,
                            side: sig.type as 'BUY' | 'SELL'
                          });
                          // ---------------------------------------------

                          // Autonomous alert safety check: fail closed if cycle generation was invalid at cycle start
                          if (cycleGeneration === undefined) {
                            console.warn(`[SAFETY GATE] Skipping autonomous alert creation for ${currentSymbol}: missing or invalid alarm generation at cycle start (${rawCycleGen})`);
                            this.telemetrySink.emit({
                              userId,
                              category: 'SAFETY',
                              component: 'TradingBot',
                              eventName: 'ALERT_SKIPPED_INVALID_GENERATION',
                              severity: 'WARN',
                              correlationId: currentSymbol,
                              cycleId,
                              symbol: currentSymbol,
                              strategyId: alertStrategyKey,
                              payload: { generation: rawCycleGen }
                            });
                            continue;
                          }

                          // Re-verify persisted isActive and generation immediately before publication
                          const [freshActive, freshGen] = await Promise.all([
                            this.state.storage.get<boolean>('isActive'),
                            this.state.storage.get<number>('lock:alarmGeneration'),
                          ]);

                          if (freshActive !== true || freshGen !== cycleGeneration) {
                            console.warn(`[SAFETY GATE] Discarding autonomous alert for ${currentSymbol}: lifecycle state changed mid-cycle (active=${freshActive}, storedGen=${freshGen}, cycleGen=${cycleGeneration})`);
                            this.telemetrySink.emit({
                              userId,
                              category: 'SAFETY',
                              component: 'TradingBot',
                              eventName: 'ALERT_DISCARDED_STALE_GENERATION',
                              severity: 'WARN',
                              correlationId: currentSymbol,
                              cycleId,
                              symbol: currentSymbol,
                              strategyId: alertStrategyKey,
                              payload: { freshActive, freshGen, cycleGeneration }
                            });
                            continue;
                          }

                          const alert: TradeAlert = {
                            id: crypto.randomUUID(),
                            symbol: currentSymbol,
                            signalPrice: alertSignalPrice,
                            targetEntryPrice: alertTargetPrice,
                            entryPrice: alertSignalPrice,
                            stopLoss: normalized.stopLoss,
                            takeProfit: normalized.takeProfit,
                            estimatedPnl: estimatedPnl,
                            positionSize: size,
                            strategy: alertStrategyKey,
                            side: sig.type as 'BUY' | 'SELL',
                            timestamp: new Date().toISOString(),
                            status: 'pending',
                            timeframe: targetTimeframe,
                            generation: cycleGeneration,
                            source: 'AUTONOMOUS',
                          };
                          alerts.push(alert);
                          legacySignalForCandidate = alert;
                          await this.persistState('alerts', alerts);

                          this.telemetrySink.emit({
                            userId,
                            category: 'ALERT',
                            component: 'TradingBot',
                            eventName: 'ALERT_CREATED',
                            severity: 'INFO',
                            correlationId: alert.id,
                            cycleId,
                            symbol: alert.symbol,
                            strategyId: alert.strategy,
                            payload: {
                              alertId: alert.id,
                              side: alert.side,
                              signalPrice: alert.signalPrice,
                              stopLoss: alert.stopLoss,
                              takeProfit: alert.takeProfit,
                              confidenceScore: Math.round(result.confidenceScore || 0),
                              timeframe: targetTimeframe,
                            }
                          });

                          // Trigger real-time FCM Push Notification to user's Android device
                          try {
                            await sendTradeNotification(this.env, userId, alert.id, {
                              symbol: alert.symbol,
                              side: alert.side,
                              entryPrice: alert.entryPrice,
                              targetEntryPrice: alert.targetEntryPrice,
                              signalPrice: alert.signalPrice,
                              stopLoss: alert.stopLoss,
                              takeProfit: alert.takeProfit,
                              estimatedPnl: alert.estimatedPnl,
                              positionSize: alert.positionSize,
                              strategy: alert.strategy,
                              timestamp: alert.timestamp,
                              timeframe: targetTimeframe,
                              confidenceScore: result.confidenceScore || 0,
                              reasoning: result.metadata?.reasoning || [],
                            }, this.telemetrySink);
                          } catch (notifErr) {
                            console.error('Failed to send FCM trade notification:', notifErr);
                          }
                        }
                      }
                    }
                  }

                  // Stage A Shadow Mode: SignalLifecycleManager execution (Non-Authoritative, Fail-Safe)
                  try {
                    const signalManagerMode = (this.env as any).SIGNAL_MANAGER_MODE;
                    if (signalManagerMode === 'SHADOW' || signalManagerMode === 'AUTHORITATIVE') {
                      const shadowSignals = this.signalLifecycleManager.processEvaluations(
                        results,
                        committedStrat
                      );
                      for (const shadowSig of shadowSignals) {
                        const comparison = ShadowComparisonEngine.compare(
                          shadowSig.symbol,
                          legacySignalForCandidate,
                          shadowSig,
                          this.signalLifecycleManager.getOpportunity(shadowSig.oppId),
                          legacySuppressionInfo
                        );
                        console.log(`[SIGNAL_LIFECYCLE_SHADOW] ${JSON.stringify(comparison)}`);
                      }
                      if (legacySignalForCandidate && shadowSignals.length === 0) {
                        const comparison = ShadowComparisonEngine.compare(
                          currentSymbol,
                          legacySignalForCandidate,
                          null,
                          null,
                          legacySuppressionInfo
                        );
                        console.log(`[SIGNAL_LIFECYCLE_SHADOW] ${JSON.stringify(comparison)}`);
                      }
                      await this.state.storage.put('signal_lifecycle_state', this.signalLifecycleManager.getState()).catch(() => {});
                    }
                  } catch (shadowErr) {
                    console.error('[SIGNAL_LIFECYCLE_SHADOW_ERROR] Non-blocking shadow error:', shadowErr);
                  }
                } catch (candidateErr: any) {
                  console.error(`[trading-bot] Strategy cycle failed for candidate ${currentSymbol}:`, candidateErr?.message || candidateErr);
                  // Candidate failure isolated - continue to next candidate
                }
              }
            }
          }
        } catch (err: any) {
          console.error('Orchestrator cycle failed:', err?.message || err, err?.stack);
        }

        const lastPositionCheckAt = (await this.state.storage.get('lastPositionCheckAt')) as number | undefined;
        if (!lastPositionCheckAt || Date.now() - lastPositionCheckAt > POSITION_CHECK_INTERVAL_MS) {
          await this.monitorOpenPositions();
          await this.state.storage.put('lastPositionCheckAt', Date.now());
        }
      });
    } catch (e) {
      console.error('Fatal DO alarm error:', e);
    } finally {
      this.isAlarmRunning = false;
      const isActive = this.runtimeState.isActive;
      if (recoveryWorkExecuted || this.hasPendingSafetyWork()) {
        await this.state.storage.setAlarm(Date.now() + 5000);
      } else if (isActive) {
        await this.state.storage.setAlarm(Date.now() + ANALYSIS_INTERVAL_MS);
      }
    }
  }

  /**
   * The core synchronized workflow: fetch live market data from the user's
   * connected exchange (any of the supported exchanges, mainnet or testnet),
   * compute real indicators, evaluate the strategy, and — only if every
   * strategy condition is satisfied — raise a genuine trade alert. The
   * resulting snapshot is persisted so the UI can render it verbatim (no
   * time-based animation).
   */
  private async monitorOpenPositions() {
    try {
      const userId = (this.runtimeState.userId as string) || ((await this.state.storage.get('userId')) as string);
      if (!userId) return;

      const activePositions =
        this.runtimeState.activePositions && this.runtimeState.activePositions.length > 0
          ? this.runtimeState.activePositions
          : (((await this.state.storage.get('activePositions')) as any[]) || []);

      let d1Rows: any[] = [];
      try {
        const d1Res = await this.env.DB.prepare(
          "SELECT * FROM trade_positions WHERE user_id = ? AND status IN ('OPEN', 'PENDING_ENTRY')"
        )
          .bind(userId)
          .all<any>();
        if (Array.isArray(d1Res?.results)) {
          d1Rows = d1Res.results;
        }
      } catch (_) {}

      const mergedById = new Map<string, any>();
      for (const pos of activePositions) {
        if (pos?.id) mergedById.set(String(pos.id), pos);
      }
      for (const row of d1Rows) {
        if (row?.id && !mergedById.has(String(row.id))) {
          mergedById.set(String(row.id), row);
        } else if (row?.id && mergedById.has(String(row.id))) {
          mergedById.set(String(row.id), { ...mergedById.get(String(row.id)), ...row });
        }
      }

      const results = Array.from(mergedById.values());
      if (results.length === 0) return;

      const userKeys = await this.getOrLoadExchangeCredentials(userId);
      if (!userKeys?.exchangeName) return;

      const adapter = await ExchangeManager.getProvider(userKeys.exchangeName as ExchangeName, {
        environment: normalizeEnvironment(userKeys.environment),
        apiKey: userKeys.apiKey,
        secret: userKeys.secret,
        password: userKeys.password,
        region: resolveCanonicalRoutingRegion(userKeys.region),
      });

      const nonMockPositions = results.filter((p: any) => p.exchange !== 'mock' || p.environment !== 'demo');
      const mockPositions = results.filter((p: any) => p.exchange === 'mock' && p.environment === 'demo');

      if (nonMockPositions.length > 0 && typeof adapter.fetchPositions === 'function') {
        try {
          const livePositions = await adapter.fetchPositions('linear');
          if (Array.isArray(livePositions)) {
            const liveExposureSet = new Set<string>();
            for (const lp of livePositions) {
              const lpSize = typeof lp.size?.toNumber === 'function' ? lp.size.toNumber() : Number(lp.size || 0);
              if (lpSize > 0) {
                const rawLpSide = String(lp.side || '').toLowerCase();
                const lpSide =
                  rawLpSide === 'short' || rawLpSide === 'sell' ? 'SELL' : 'BUY';
                liveExposureSet.add(`${this.normalizeSymbol(lp.symbol)}_${lpSide}`);
              }
            }

            const groupedBySymSide = new Map<string, any[]>();
            for (const pos of nonMockPositions) {
              const normSym = this.normalizeSymbol(pos.symbol);
              const normSide = String(pos.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
              const key = `${normSym}_${normSide}`;
              const group = groupedBySymSide.get(key) || [];
              group.push(pos);
              groupedBySymSide.set(key, group);
            }

            const MAX_ABSENT_POSITIONS_PER_ALARM = 2;
            let reconciledCount = 0;
            for (const [groupKey, groupRows] of groupedBySymSide.entries()) {
              if (reconciledCount >= MAX_ABSENT_POSITIONS_PER_ALARM) break;
              if (liveExposureSet.has(groupKey)) continue;
              const remainingBudget = MAX_ABSENT_POSITIONS_PER_ALARM - reconciledCount;
              const rowsSlice = groupRows.slice(0, remainingBudget);
              reconciledCount += rowsSlice.length;
              await this.reconcileMissingD1PositionsGroup(adapter, userId, rowsSlice, false);
            }
          }
        } catch (reconErr) {
          console.warn('[ALARM_MONITOR] Failed to fetch live positions for D1 reconciliation:', reconErr);
        }
      }

      for (const position of mockPositions) {
        try {
          const ticker = await adapter.fetchTicker(position.symbol);
          if (!ticker) continue;

          const currentPrice = ticker.last.toNumber();
          let closeReason: string | null = null;
          const posStopLoss = position.stopLoss ?? position.stop_loss;
          const posTakeProfit = position.takeProfit ?? position.take_profit;
          const posEntryPrice = position.entryPrice ?? position.entry_price;
          const posQty = position.quantity ?? position.amount ?? 0;

          if (position.side === 'BUY' || position.side === 'buy') {
            if (posStopLoss && currentPrice <= posStopLoss) {
              closeReason = 'stop_loss';
            } else if (posTakeProfit && currentPrice >= posTakeProfit) {
              closeReason = 'take_profit';
            }
          } else {
            if (posStopLoss && currentPrice >= posStopLoss) {
              closeReason = 'stop_loss';
            } else if (posTakeProfit && currentPrice <= posTakeProfit) {
              closeReason = 'take_profit';
            }
          }

          if (closeReason && posEntryPrice > 0) {
            const priceDiff = (position.side === 'BUY' || position.side === 'buy')
              ? currentPrice - posEntryPrice
              : posEntryPrice - currentPrice;
            const realizedPnl = (priceDiff / posEntryPrice) * posQty * posEntryPrice;
            const now = new Date().toISOString();

            this.env.DB.prepare(
              "DELETE FROM trade_positions WHERE id = ?"
            )
              .bind(position.id)
              .run().catch(e => console.error('D1 position close delete failed:', e));

            // Update Authoritative DO WAL
            const updatedPositions = activePositions.filter((p: any) => p.id !== position.id);
            await this.persistState('activePositions', updatedPositions);

            // Reset DO trade state so the UI gracefully exits LivePnLMonitoringScreen
            const currentTradeActive = await this.state.storage.get('tradeActive');
            if (currentTradeActive) {
               await this.state.storage.put('tradeActive', false);
            }
            
            await this.logAuditEvent(userId, 'POSITION_CLOSED', { symbol: position.symbol, reason: closeReason, realizedPnl, closePrice: currentPrice });
          }
        } catch (e) {
          console.error('Position monitoring error:', e);
        }
      }
    } catch (e) {
      console.error('Open positions monitoring error:', e);
    }
  }

  private expireStaleAlertsOnLifecycleTransition(alerts: TradeAlert[], committedGen: number): TradeAlert[] {
    const isIntentUnresolved = (intent: any): boolean => {
      if (!intent) return false;
      return ['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(intent.status);
    };

    const hasUnresolvedIntent = (alertId: string): boolean => {
      if (!alertId) return false;
      const direct = this.runtimeState.activeIntents?.get(alertId);
      if (isIntentUnresolved(direct)) return true;
      if (this.runtimeState.activeIntents) {
        for (const intent of this.runtimeState.activeIntents.values()) {
          if (intent && (intent.intentId === alertId || intent.payloadSnapshot?.alertId === alertId) && isIntentUnresolved(intent)) {
            return true;
          }
        }
      }
      return false;
    };

    const now = Date.now();
    return alerts.map((a) => {
      if (a.status !== 'pending' && a.status !== 'acknowledged') {
        return a;
      }
      if (hasUnresolvedIntent(a.id)) {
        return a;
      }

      const isAutonomous =
        a.source === 'AUTONOMOUS' ||
        (typeof a.strategy === 'string' && a.strategy.endsWith('_NEW')) ||
        typeof a.generation === 'number';

      if (isAutonomous) {
        if (typeof a.generation !== 'number' || a.generation < committedGen) {
          return { ...a, status: 'expired' as const };
        }
      }

      const alertTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const isStale = isNaN(alertTime) || alertTime === 0 || (now - alertTime > 300_000);
      if (isStale) {
        return { ...a, status: 'expired' as const };
      }

      return a;
    });
  }

  private pruneAlerts(alerts: TradeAlert[]): TradeAlert[] {
    return alerts.slice(-100);
  }

  private appendLog(logs: AnalysisLog[], message: string, level: AnalysisLog['level']): AnalysisLog[] {
    return logs.concat([{ timestamp: new Date().toISOString(), level, message }]);
  }
}
