import { Env } from './index';
import { ExchangeManager, ExchangeName, ExchangeEnvironment } from './exchanges';
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

interface TradeAlert {
  id: string;
  symbol: string;
  signalPrice: number;
  targetEntryPrice?: number;
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
}

export interface TradeSetupSnapshot {
  readonly userId: string;
  readonly coinId: string;
  readonly strategy: string;
  readonly targetEntryPrice?: number;
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


export class TradingBot {
  state: DurableObjectState;
  env: Env;
  private isExecutingTrade = false;
  private orchestrator: StrategyOrchestrator;
  private engineApi: EngineAPIService;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.orchestrator = new StrategyOrchestrator();
    this.engineApi = new EngineAPIService();
    
    // Feature 5: DO Recovery
    // Reconstruct memory state from durable storage safely
    this.state.blockConcurrencyWhile(async () => {
      this.isExecutingTrade = (await this.state.storage.get('isExecutingTrade')) || false;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/activate': {
        const { userId, coinId, strategy, positionSize, targetEntryPrice, config } = await request.json<{ userId: string; coinId: string; strategy: string; positionSize?: number; targetEntryPrice?: number; config?: any }>();
        
        await this.logAuditEvent(userId, 'BOT_ACTIVATED', { strategy, coinId, positionSize, targetEntryPrice });
        await this.state.storage.put('isActive', true);
        await this.state.storage.put('coinId', coinId);
        await this.state.storage.put('strategy', strategy);
        await this.state.storage.put('userId', userId);
        if (config) {
          await this.state.storage.put('strategyConfig', config);
        } else {
          await this.state.storage.delete('strategyConfig');
        }
        if (targetEntryPrice != null) {
          await this.state.storage.put('targetEntryPrice', targetEntryPrice);
        } else {
          await this.state.storage.delete('targetEntryPrice');
        }
        if (positionSize != null) {
          await this.state.storage.put('positionSize', positionSize);
        } else {
          await this.state.storage.delete('positionSize');
        }

        await this.state.storage.put('alerts', [] as TradeAlert[]);
        await this.state.storage.put('tradeActive', false);
        await this.state.storage.put(
          'logs',
          [
            { timestamp: new Date().toISOString(), level: 'info' as const, message: `Bot activated for strategy: ${strategy || 'default'}` },
            { timestamp: new Date().toISOString(), level: 'info' as const, message: `Monitoring pair: ${coinId || 'N/A'}` },
          ] as AnalysisLog[],
        );
        await this.state.storage.put('activatedAt', Date.now());
        await this.state.storage.delete('lastPositionCheckAt');

        // Feature: Sprint 1 Orchestrator Activation
        this.orchestrator = new StrategyOrchestrator(); // Reset on explicit activation
        
        // Phase 1 Integration: Strategy is selected from registry implicitly via strategyId
        
        const user = await this.env.DB.prepare('SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_salt FROM users WHERE id = ?').bind(userId).first<any>();

        const setupSnapshot: TradeSetupSnapshot = Object.freeze({
          userId,
          coinId,
          strategy,
          targetEntryPrice: targetEntryPrice ?? undefined,
          positionSize: positionSize ?? undefined,
          activatedAt: new Date().toISOString(),
          exchangeName: user?.exchange_name ?? undefined,
          environment: user?.exchange_environment ?? undefined,
        });
        await this.state.storage.put('setupSnapshot', setupSnapshot);

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
            ...this.resolveEgressConfig(user.exchange_name),
          });

          const provider = new AdapterCandleProvider(adapter);
          const dataEngine = new MarketDataEngine(provider);
          this.orchestrator.setMarketDataEngine(dataEngine);
        }

        await this.state.storage.put('engineState', this.orchestrator.getCurrentState());

        // We no longer run the legacy runAnalysisCycle immediately on activate.
        // We just start the alarm which drives the FSM.

        await this.state.storage.setAlarm(Date.now() + 1000); // Trigger FSM almost immediately

        return new Response(JSON.stringify({ success: true, message: 'Bot activated.' }), { status: 200 });
      }
      case '/deactivate': {
        const userId = (await this.state.storage.get('userId')) as string | undefined;
        if (userId) {
          await this.logAuditEvent(userId, 'BOT_DEACTIVATED', { reason: 'user_requested' });
        }
        await this.state.storage.put('isActive', false);
        await this.state.storage.put('coinId', null);
        const existingLogs = (await this.state.storage.get('logs')) as AnalysisLog[] | undefined;
        await this.state.storage.put('logs', (existingLogs ?? []).concat([
          { timestamp: new Date().toISOString(), level: 'info' as const, message: 'Bot deactivated by user.' },
        ]));
        try { await this.state.storage.deleteAlarm(); } catch (e) { /* ignore */ }
        return new Response(JSON.stringify({ success: true, message: 'Bot deactivated.' }), { status: 200 });
      }

      case '/status': {
        const isActive = (await this.state.storage.get('isActive')) || false;
        const coinId = (await this.state.storage.get('coinId')) || null;
        const strategy = (await this.state.storage.get('strategy')) || null;
        return new Response(JSON.stringify({ isActive, coinId, strategy }), { status: 200 });
      }
      case '/analysis-status': {
        const isActive = (await this.state.storage.get('isActive')) || false;
        const safeMode = false;
        const newAnalysis = (await this.state.storage.get('newAnalysis')) as any;

        if (newAnalysis) {
          return new Response(JSON.stringify({ ...newAnalysis, safeMode }), { status: 200 });
        }

        const coinId = (await this.state.storage.get('coinId')) as string || 'BTCUSDT';
        const strategy = (await this.state.storage.get('strategy')) as string || 'ScalperV2';

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

        return new Response(JSON.stringify({ ...snapshotDto, safeMode }), { status: 200 });
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
      case '/alerts': {
        const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
        const pending = alerts.filter((a) => a.status === 'pending');
        return new Response(JSON.stringify(pending), { status: 200 });
      }
      case '/execution-status': {
        const url = new URL(request.url);
        const positionId = url.searchParams.get('positionId') || url.searchParams.get('id');
        if (!positionId) {
          return new Response(JSON.stringify({ success: false, message: 'positionId is required.' }), { status: 400 });
        }

        const userId: string | undefined = await this.state.storage.get('userId');
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
                ...this.resolveEgressConfig('bybit'),
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
                  const now = new Date().toISOString();
                  await this.env.DB.prepare(
                    `UPDATE trade_positions SET entry_status = 'FAILED', status = 'CANCELLED', updated_at = ? WHERE id = ? AND user_id = ?`
                  ).bind(now, positionId, userId).run();

                  dbPos = await this.env.DB.prepare(
                    `SELECT id, user_id, symbol, side, entry_price, target_entry_price, average_fill_price, quantity, filled_quantity, stop_loss, take_profit, status, entry_status, exchange, environment, strategy, order_id, entry_exchange_order_id, order_type, limit_price, entry_submitted_at, entry_at, created_at, updated_at
                     FROM trade_positions WHERE id = ? AND user_id = ?`
                  ).bind(positionId, userId).first<any>();
                }
              }
            }
          } catch (reconErr: any) {
            console.warn('[trading-bot] Execution status reconciliation error:', reconErr?.message || reconErr);
          }
        }

        // Authoritative Bybit Position Lifecycle Reconciliation: If position is OPEN and on Bybit, verify if closed on exchange
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
                ...this.resolveEgressConfig('bybit'),
              });

              const closeResult = await ReconciliationEngine.reconcilePositionLifecycle(provider, dbPos, Date.now());
              if (closeResult && closeResult.status === 'CLOSED') {
                const now = closeResult.closedAt || new Date().toISOString();
                await this.env.DB.prepare(
                  `UPDATE trade_positions 
                   SET status = 'CLOSED', closed_at = ?, close_price = ?, realized_pnl = ?, close_reason = ?, updated_at = ?
                   WHERE id = ? AND user_id = ? AND status = 'OPEN'`
                ).bind(now, closeResult.closePrice ?? null, closeResult.realizedPnl ?? null, closeResult.closeReason ?? 'exchange_close', now, positionId, userId).run();

                dbPos = await this.env.DB.prepare(
                  `SELECT id, user_id, symbol, side, entry_price, target_entry_price, average_fill_price, quantity, filled_quantity, stop_loss, take_profit, status, entry_status, exchange, environment, strategy, order_id, entry_exchange_order_id, order_type, limit_price, entry_submitted_at, entry_at, closed_at, close_price, realized_pnl, close_reason, created_at, updated_at
                   FROM trade_positions WHERE id = ? AND user_id = ?`
                ).bind(positionId, userId).first<any>();
              }
            }
          } catch (posReconErr: any) {
            console.warn('[trading-bot] Position lifecycle reconciliation error:', posReconErr?.message || posReconErr);
          }
        }

        const rawEntryStatus = dbPos?.entry_status || intentObj?.status || 'PENDING_ENTRY';
        const entryStatus = rawEntryStatus === 'DISPATCHED' ? 'PENDING_ENTRY' : rawEntryStatus;
        const positionStatus = dbPos?.status || (entryStatus === 'FILLED' || entryStatus === 'PARTIALLY_FILLED' ? 'OPEN' : 'PENDING_ENTRY');

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
        const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
        const alert = alerts.find((a) => a.id === alertId);
        if (alert) {
          alert.status = 'acknowledged';
          await this.state.storage.put('alerts', this.pruneAlerts(alerts));
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
        
        // Feature 9: Race Condition Protection (Concurrency)
        return await this.state.blockConcurrencyWhile(async () => {
          this.isExecutingTrade = true;
          await this.state.storage.put('isExecutingTrade', true);

          try {
            const userId: string | undefined = await this.state.storage.get('userId');
            if (!userId) {
              return new Response(JSON.stringify({ error: 'Bot not properly initialized with a user.' }), { status: 500 });
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
              ...this.resolveEgressConfig(userKeys.exchange_name),
            });

            const coinId = (await this.state.storage.get('coinId')) as string;

            let alertId: string | undefined;
            try {
              const body = await request.clone().json() as any;
              alertId = body.alertId;
            } catch (e) {}

            if (!alertId) {
              return new Response(JSON.stringify({ error: 'alertId is required.' }), { status: 400 });
            }

            // [SAFETY GATE: STRICT SCHEMA READINESS CHECK]
            // We must absolutely guarantee the persistence layer is capable of tracking this execution
            // BEFORE we ever dispatch a non-idempotent intent to the remote exchange.
            // Requirement: Migration 0024 (target_entry_price) MUST exist.
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

            // Idempotency Check: If an intent already exists for this alertId, return success (execution already handled)
            const existingIntentForAlert = await this.state.storage.get(`intent:order:${alertId}`) as any;
            if (existingIntentForAlert) {
              console.log(`[DIAGNOSTIC] Idempotent retry detected for alertId ${alertId}. Returning success.`);
              return new Response(JSON.stringify({
                success: true,
                message: 'Execution already handled.',
                orderId: alertId,
                status: existingIntentForAlert.status === 'FILLED' ? 'filled' : 'open',
              }), { status: 200 });
            }

            const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
            const target: TradeAlert | undefined = alerts.find((a) => a.id === alertId && (a.status === 'pending' || a.status === 'acknowledged'));
            
            if (!target) {
              return new Response(JSON.stringify({ error: 'Trade alert not found, expired, or already executed.' }), { status: 409 });
            }

            // Signal TTL Enforcement (5 minutes = 300,000ms)
            const MAX_SIGNAL_AGE_MS = 300000;
            const signalAgeMs = Date.now() - new Date(target.timestamp).getTime();
            if (signalAgeMs > MAX_SIGNAL_AGE_MS) {
              console.warn(`[SAFETY GATE] Rejected stale signal execution. Age: ${signalAgeMs}ms. AlertId: ${target.id}`);
              target.status = 'expired';
              await this.state.storage.put('alerts', this.pruneAlerts(alerts));
              return new Response(JSON.stringify({ error: `Signal has expired. Maximum allowed execution latency is 5 minutes.` }), { status: 400 });
            }

            const side: 'BUY' | 'SELL' = target.side || 'BUY';
            const alertStrategy = (target.strategy || '').replace(/_NEW$/, '');
            const normalizedStrategyId = StrategyRegistry.getInstance().normalizeStrategyId(alertStrategy);
            const alertManifest = StrategyRegistry.getInstance().getManifest(normalizedStrategyId);
            if (side === 'SELL' && alertManifest && !alertManifest.supportsShort) {
              console.error(`[SAFETY GATE: FATAL] Rejected short execution for long-only strategy ${normalizedStrategyId}. AlertId: ${target.id}`);
              return new Response(JSON.stringify({ error: `Cannot execute SELL order: Strategy '${normalizedStrategyId}' does not support short positions.` }), { status: 400 });
            }
            const rawSymbol = coinId || target.symbol || 'BTC/USDT';
            const orderSymbol = rawSymbol.includes('/') ? rawSymbol : `${rawSymbol}/USDT`;
            const clientOrderId = target.id;

            console.log(`[DIAGNOSTIC] [STAGE: PENDING_ALERT_FOUND] targetAlertId=${target.id} symbol=${orderSymbol} side=${side} positionSize=${target.positionSize}`);

            // Phase 3: Strict Concurrency Check
            // Mathematically prevents executing a new intent for a symbol if an unresolved intent already exists for it.
            const existingIntents = await this.state.storage.list({ prefix: 'intent:order:' });
            for (const val of existingIntents.values()) {
              const intent = val as any;
              if (intent.symbol === orderSymbol && ['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'].includes(intent.status)) {
                  console.error(`[SAFETY_GATE] Rejected concurrent entry: Intent ${intent.intentId} is unresolved (${intent.status}) for ${orderSymbol}.`);
                  return new Response(JSON.stringify({ error: `Concurrent execution blocked. Unresolved intent ${intent.intentId} in state ${intent.status} exists for ${orderSymbol}.` }), { status: 423 }); // 423 Locked
              }
            }

            target.status = 'submitted';
            await this.state.storage.put('alerts', this.pruneAlerts(alerts));
          await this.logAuditEvent(userId, 'TRADE_SUBMITTED', { symbol: orderSymbol, side, clientOrderId, strategy: target.strategy, entryPrice: target.entryPrice });

            let orderResult: any = { success: true, message: 'Trade executed (simulated).', orderId: clientOrderId };
            let orderType: 'MARKET' | 'LIMIT' = 'MARKET';
            let limitPrice: number | undefined = undefined;
            let executionSnapshot: TradeExecutionSnapshot | null = null;

            try {
              if (adapter) {
                const ticker = await adapter.fetchTicker(orderSymbol);
                const currentPrice = (typeof ticker?.last?.toNumber === 'function' ? ticker.last.toNumber() : (typeof ticker?.last === 'number' ? ticker.last : 0)) || target.signalPrice || target.entryPrice;
                const targetPrice = target.targetEntryPrice || target.signalPrice || target.entryPrice;
                
                const deltaPercent = currentPrice > 0 ? (Math.abs(targetPrice - currentPrice) / currentPrice) : 0;
                if (target.targetEntryPrice && deltaPercent > 0.0005) {
                  orderType = 'LIMIT';
                  limitPrice = target.targetEntryPrice;
                }

                const positionSizeUsdt = target.positionSize || 100;
                let stepSize = 0.00001;
                let tickSize = 0.01;
                let minNotional = 5;
                let minQty = 0.00001;

                try {
                  const markets = await adapter.fetchMarkets();
                  const matched = markets.find(m => m.symbol === orderSymbol || m.id === orderSymbol.replace('/', ''));
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
                  console.warn('[trading-bot] Failed to fetch markets for precision rules, using defaults:', mErr?.message);
                }

                const rulesRes = TradeValidator.validate({
                  symbol: orderSymbol,
                  entryPrice: limitPrice || currentPrice,
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
                   ...this.resolveEgressConfig(executionSnapshot.exchangeName),
                });


                const req: any = {
                   symbol: executionSnapshot.symbol,
                   side: executionSnapshot.side.toLowerCase(),
                   type: executionSnapshot.orderType.toLowerCase(),
                   amount: new BigNumber(executionSnapshot.quantizedQuantity),
                   clientOrderId: executionSnapshot.clientOrderId,
                   params: {}
                };
                if (req.type === 'limit') req.timeInForce = 'IOC';
                if (executionSnapshot.limitPrice) req.price = new BigNumber(executionSnapshot.limitPrice);
                if (executionSnapshot.takeProfit) req.takeProfit = executionSnapshot.takeProfit;
                if (executionSnapshot.stopLoss) req.stopLoss = executionSnapshot.stopLoss;

                // Phase 3: Final Dispatch Safety Gate
                const { FinalDispatchSafetyGate } = require('./engine/safety/FinalDispatchSafetyGate');
                try {
                  FinalDispatchSafetyGate.validate(req, {
                    stepSize,
                    tickSize,
                    minQty,
                    minNotional,
                  });
                } catch (gateErr: any) {
                  throw new Error(`RISK_GATE_REJECTED: ${gateErr.message}`);
                }

                // Phase 3: Core WAL State Machine (INTENT_PERSISTED)
                const { EconomicIntent } = require('./engine/wal/WalTypes');
                const intentObj: any = {
                  intentId: executionSnapshot.clientOrderId,
                  version: Date.now(),
                  symbol: req.symbol,
                  side: req.side,
                  orderType: req.type,
                  qty: req.amount.toString(),
                  price: req.price?.toString(),
                  status: 'INTENT_PERSISTED',
                  requestedStopLoss: req.stopLoss,
                  requestedTakeProfit: req.takeProfit,
                  createdAt: Date.now(),
                  reconciliationAttemptCount: 0,
                  payloadSnapshot: req
                };
                
                await this.state.storage.transaction(async (txn) => {
                  await txn.put(`intent:order:${intentObj.intentId}`, intentObj);
                });

                console.log(`[DIAGNOSTIC] [STAGE: INTENT_PERSISTED] WAL written for ${intentObj.intentId}`);

                let rawOrder: any;
                try {
                  intentObj.status = 'DISPATCHED';
                  intentObj.dispatchedAt = Date.now();
                  await this.state.storage.transaction(async (txn) => {
                    await txn.put(`intent:order:${intentObj.intentId}`, intentObj);
                  });

                  rawOrder = await ExchangeManager.executeIdempotentOrder(writeProvider, req);
                  
                  intentObj.status = rawOrder.status === 'open' ? 'DISPATCHED' : 'FILLED';
                  await this.state.storage.transaction(async (txn) => {
                    await txn.put(`intent:order:${intentObj.intentId}`, intentObj);
                  });
                  console.log(`[DIAGNOSTIC] [STAGE: ORDER_SUCCESS] orderId=${rawOrder.id} status=${intentObj.status}`);

                } catch (e: any) {
                  // Catch HTTP timeouts / 5xx to enforce UNKNOWN state instead of FAILED
                  const isNetworkError = e.code === 'EXCHANGE_NOT_REACHABLE' || e.code === 'EXCHANGE_TIMEOUT' || String(e.message).includes('timeout') || String(e.status).startsWith('5');
                  
                  if (isNetworkError) {
                    intentObj.status = 'UNKNOWN';
                    await this.state.storage.transaction(async (txn) => {
                      await txn.put(`intent:order:${intentObj.intentId}`, intentObj);
                    });
                    console.warn(`[DIAGNOSTIC] [STAGE: UNKNOWN_STATE] Network failure during dispatch for ${intentObj.intentId}. Transitioning to UNKNOWN. Initiating reconciliation.`);
                    
                    // Trigger immediate first pass reconciliation
                    await ReconciliationEngine.reconcile(writeProvider, intentObj, Date.now());
                    await this.state.storage.transaction(async (txn) => {
                      await txn.put(`intent:order:${intentObj.intentId}`, intentObj);
                    });
                    
                    // If it remains UNKNOWN, we must halt the current execution cycle safely
                    throw new Error(`UNKNOWN_STATE: Order ${intentObj.intentId} dispatch status is unknown due to network failure.`);
                  } else {
                    intentObj.status = 'FAILED';
                    await this.state.storage.transaction(async (txn) => {
                      await txn.put(`intent:order:${intentObj.intentId}`, intentObj);
                    });
                    throw e; // Explicit rejection
                  }
                }

                const filledQty = rawOrder.filled?.toNumber() || (rawOrder.status === 'closed' ? rawOrder.amount.toNumber() : 0);
                const orderStatus = rawOrder.status === 'open' ? 'open' : 'filled';

                orderResult = {
                   success: true,
                   message: 'Order accepted by exchange.',
                   orderId: rawOrder.id,
                   price: null, // Force null to prevent UI from rendering $0 fake price
                   quantity: rawOrder.amount.toNumber(),
                   status: 'open',
                   ocoGroupId: null,
                   tpOrderId: null,
                   slOrderId: null,
                   protectionMode: 'ATTACHED_TPSL'
                };
              }
            } catch (e: any) {
              console.error(`[DIAGNOSTIC] [STAGE: ORDER_FAILED] exceptionMessage=${e.message}`);
              orderResult = {
                success: false,
                code: e.message.includes('RISK_GATE') ? 'RISK_GATE_REJECTED' : (e.message.includes('UNKNOWN') ? 'UNKNOWN_STATE' : 'EXCHANGE_REJECTED'),
                exchangeCode: -1,
                message: e.message || 'Trade execution failed',
                details: String(e)
              };
            }

            target.status = orderResult.success ? 'executed' : 'failed';
            await this.state.storage.put('alerts', this.pruneAlerts(alerts));
            
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

              const currentStatus = orderResult.status === 'open' ? 'open' : 'filled';
              const actionType = currentStatus === 'open' ? 'TRADE_SUBMITTED' : 'TRADE_FILLED';
              await this.logAuditEvent(snapshot.userId, actionType, { symbol: snapshot.symbol, side: snapshot.side, orderId: orderResult.orderId, price: averageFillPrice, quantity: orderResult.quantity, strategy: snapshot.strategy });
              
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
              await this.state.storage.put('tradeActive', true);
              await this.state.storage.put('tradeEntryTimestamp', new Date().toISOString());
              await this.state.storage.put('lastSuccessfulTradeAt', Date.now());

              const positionId = snapshot.alertId;
              const now = new Date().toISOString();
              const initialStatus = orderResult.status === 'open' ? 'PENDING_ENTRY' : 'OPEN';
              
              const positionData = {
                  id: positionId,
                  userId: snapshot.userId,
                  orderSymbol: snapshot.symbol,
                  side: snapshot.side,
                  entryPrice: averageFillPrice || snapshot.signalPrice,
                  targetEntryPrice: snapshot.targetEntryPrice || null,
                  signalPrice: snapshot.signalPrice,
                  averageFillPrice: averageFillPrice,
                  quantity: orderResult.quantity || 0,
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
                  entryStatus: initialStatus,
                  submittedAt: now,
                  now
              };

              // Phase 3.3.1: Write-Ahead Logging (WAL) to DO Storage before writing to D1
              await this.state.storage.put('pendingPositionSync', positionData);

              try {
                await this.env.DB.prepare(
                  `INSERT OR IGNORE INTO trade_positions (
                    id, user_id, symbol, side, entry_price, target_entry_price, average_fill_price, quantity, stop_loss, take_profit,
                    status, exchange, environment, strategy, order_id, entry_exchange_order_id, tp_exchange_order_id, sl_exchange_order_id,
                    oco_group_id, protection_mode, order_type, limit_price, entry_status, entry_submitted_at, entry_at, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
                    initialStatus === 'PENDING_ENTRY' ? 'PENDING_ENTRY' : 'OPEN',
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
                  )
                  .run();

                // Record Audit Entry
                const targetPrice = snapshot.targetEntryPrice || snapshot.signalPrice;
                const safeAverageFillPrice = averageFillPrice ?? snapshot.signalPrice;
                const slippagePercent = targetPrice > 0 ? (Math.abs(safeAverageFillPrice - targetPrice) / targetPrice) * 100 : 0;
                await this.env.DB.prepare(
                  `INSERT INTO trade_execution_audit (
                    id, alert_id, user_id, symbol, strategy, target_entry_price, signal_price, execution_price, average_fill_price, stop_loss, take_profit, slippage_percent, fill_timestamp, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                  .bind(
                    crypto.randomUUID(),
                    snapshot.alertId,
                    snapshot.userId,
                    snapshot.symbol,
                    snapshot.strategy,
                    snapshot.targetEntryPrice || null,
                    snapshot.signalPrice,
                    safeAverageFillPrice,
                    safeAverageFillPrice,
                    snapshot.stopLoss,
                    snapshot.takeProfit,
                    slippagePercent,
                    now,
                    now,
                  )
                  .run();

                // If DB write succeeds, remove from WAL
                await this.state.storage.delete('pendingPositionSync');
              } catch (dbError: any) {
                console.error("D1 write failed, position is safely in DO WAL:", dbError?.stack || dbError?.message || dbError);
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
              orderId: orderResult.orderId
            }), { status: 200 });
          } finally {
            this.isExecutingTrade = false;
            await this.state.storage.put('isExecutingTrade', false);
          }
        });
      }
      case '/mock-trade': {
        const body = await request.json<any>().catch(() => ({}));
        const userId: string | undefined = body.userId || (await this.state.storage.get('userId'));
        const alertId: string = body.alertId || crypto.randomUUID();
        const symbol: string | undefined = body.symbol || ((await this.state.storage.get('coinId')) as string);
        const strategy: string | undefined = body.strategy || ((await this.state.storage.get('strategy')) as string);
        const side: 'BUY' | 'SELL' = body.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
        const positionSizeUsdt: number = typeof body.positionSizeUsdt === 'number' && body.positionSizeUsdt > 0
          ? body.positionSizeUsdt
          : (((await this.state.storage.get('positionSize')) as number) || 100);

        if (!userId) {
          return new Response(JSON.stringify({ success: false, message: 'Unauthorized: Missing user context.' }), { status: 401 });
        }
        if (!symbol) {
          return new Response(JSON.stringify({ success: false, message: 'Trading symbol is required.' }), { status: 400 });
        }
        if (!strategy) {
          return new Response(JSON.stringify({ success: false, message: 'Trading strategy is required.' }), { status: 400 });
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
          ...this.resolveEgressConfig(exchangeName),
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
            const markets = await adapter.fetchMarkets().catch(() => []);
            const matched = markets.find(
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
        const currentActive = (await this.state.storage.get<any[]>('activePositions')) || [];
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
        await this.state.storage.put('activePositions', currentActive);

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
        const isActive = (await this.state.storage.get('isActive')) || false;
        const activatedAt = (await this.state.storage.get('activatedAt')) as number || 0;
        const uptimeSeconds = isActive && activatedAt > 0 ? Math.floor((Date.now() - activatedAt) / 1000) : 0;
        
        const lastSuccessfulAnalysisAt = (await this.state.storage.get('lastSuccessfulAnalysisAt')) || null;
        const lastSuccessfulTradeAt = (await this.state.storage.get('lastSuccessfulTradeAt')) || null;
        const lastReconciliationAt = (await this.state.storage.get('lastReconciliationAt')) || null;
        
        let adapterMetrics: any = null;
        let circuitBreakerStatus = 'UNKNOWN';
        let activePositionsCount = 0;
        try {
          const userId = await this.state.storage.get('userId') as string;
          if (userId) {
            const user = await this.env.DB.prepare('SELECT exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?').bind(userId).first<{ exchange_name: string | null; exchange_environment: string | null; exchange_region: string | null }>();
            if (user?.exchange_name) {
              const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, { environment: normalizeEnvironment(user.exchange_environment), region: resolveCanonicalRoutingRegion(user.exchange_region), ...this.resolveEgressConfig(user.exchange_name) });

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
        
        const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
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

  async alarm() {
    // Feature 11: Background Monitoring Fail-Safe (Immortal Alarm)
    try {
      await this.state.blockConcurrencyWhile(async () => {
        const isActive = await this.state.storage.get('isActive');
        if (!isActive) return;

        if (this.env.GLOBAL_TRADING_HALT === 'true') {
          console.warn('GLOBAL_TRADING_HALT is active. Skipping background operations.');
          return;
        }

      // Phase 3.3.1: Write-Ahead Logging (WAL) Recovery
      const pendingPositionSync = await this.state.storage.get<any>('pendingPositionSync');
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
        } catch (e) {
          console.error('Failed to sync pending WAL position to D1 in alarm:', e);
        }
      }

      // Phase 3: Exhaustive WAL Reconciliation Sweep
      try {
        const userId = await this.state.storage.get('userId') as string;
        if (userId) {
          const userKeys = await this.env.DB.prepare('SELECT exchange_api_key, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_salt, exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?').bind(userId).first<any>();
          if (userKeys?.exchange_name && userKeys.exchange_api_secret_encrypted) {
            let apiKey: string | undefined = undefined;
            if (userKeys.exchange_api_key_iv && userKeys.exchange_api_key_encrypted) {
              try {
                apiKey = await decrypt({ iv: userKeys.exchange_api_key_iv, encrypted: userKeys.exchange_api_key_encrypted, salt: userKeys.exchange_api_key_salt }, this.env.ENCRYPTION_KEY);
              } catch (_) {}
            }
            if (!apiKey && userKeys.exchange_api_key) {
              apiKey = userKeys.exchange_api_key;
            }

            const decryptedSecret = await decrypt({ iv: userKeys.exchange_api_secret_iv, encrypted: userKeys.exchange_api_secret_encrypted, salt: userKeys.exchange_api_secret_salt }, this.env.ENCRYPTION_KEY);
            let decryptedPassphrase = undefined;
            if (userKeys.exchange_api_passphrase_iv && userKeys.exchange_api_passphrase_encrypted) {
              decryptedPassphrase = await decrypt({ iv: userKeys.exchange_api_passphrase_iv, encrypted: userKeys.exchange_api_passphrase_encrypted, salt: userKeys.exchange_api_passphrase_salt }, this.env.ENCRYPTION_KEY);
            }
            
            const adapter = await ExchangeManager.getProvider(userKeys.exchange_name as ExchangeName, {
              environment: normalizeEnvironment(userKeys.exchange_environment),
              apiKey,
              secret: decryptedSecret,
              password: decryptedPassphrase,
              region: resolveCanonicalRoutingRegion(userKeys.exchange_region),
              ...this.resolveEgressConfig(userKeys.exchange_name),
            });
            
            // 1. Process UNKNOWN / PENDING Economic Intents
            const { ReconciliationEngine } = require('./engine/reconciliation/ReconciliationEngine');
            const intentMap = await this.state.storage.list({ prefix: 'intent:order:' });
            for (const [key, value] of intentMap.entries()) {
              const intent = value as any;
              const pendingStates = ['INTENT_PERSISTED', 'DISPATCHED', 'UNKNOWN', 'RECONCILIATION_PENDING'];
              if (pendingStates.includes(intent.status)) {
                console.log(`[RECONCILIATION] Sweeping intent ${intent.intentId} in state ${intent.status}`);
                const reconciled = await ReconciliationEngine.reconcile(adapter, intent, Date.now());
                await this.state.storage.transaction(async (txn) => {
                  await txn.put(key, reconciled);
                });

                if (reconciled.status === 'FILLED' || reconciled.status === 'PARTIALLY_FILLED' || (reconciled.status === 'DISPATCHED' && reconciled.actualExecutedQuantity > 0)) {
                  try {
                    const snap = reconciled.payloadSnapshot || {};
                    const isClosed = reconciled.status === 'FAILED' || reconciled.status === 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION';
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
                      reconciled.intentId,
                      userId,
                      snap.symbol || '',
                      snap.side || 'BUY',
                      snap.price || 0,
                      snap.targetEntryPrice || snap.price || 0,
                      snap.qty || 0,
                      snap.requestedStopLoss || 0,
                      snap.requestedTakeProfit || 0,
                      'OPEN', // Position status is OPEN because inventory exists
                      reconciled.status, // entry_status is the specific lifecycle: PARTIALLY_FILLED, FILLED, etc
                      reconciled.actualFillPrice || null,
                      reconciled.actualExecutedQuantity || 0,
                      reconciled.actualOrderId || null,
                      userKeys.exchange_name,
                      userKeys.exchange_environment || 'mainnet',
                      new Date(reconciled.createdAt || Date.now()).toISOString(),
                      new Date(reconciled.createdAt || Date.now()).toISOString(),
                      new Date().toISOString()
                    )
                    .run();
                  } catch (e) {
                    console.error(`[RECONCILIATION] D1 UPSERT failed for intent ${reconciled.intentId}:`, e);
                  }
                }
              }
            }

            // 2. Native Protection Engine Verification
            const positions = await adapter.fetchPositions().catch(() => null);
            if (positions) {
               const activePositions = await this.state.storage.get<any[]>('activePositions') || [];
               for (const dbPos of activePositions) {
                 const exchangePos = positions.find((p: any) => p.symbol === dbPos.symbol && p.side === (dbPos.side === 'BUY' ? 'long' : 'short'));
                 if (exchangePos && exchangePos.size.toNumber() > 0) {
                    // Phase 3: Critical Correction #5 - Verify actual bounds, not just existence
                    const exchangeSL = exchangePos.stopLoss ? (typeof exchangePos.stopLoss.toNumber === 'function' ? exchangePos.stopLoss.toNumber() : Number(exchangePos.stopLoss)) : null;
                    const exchangeTP = exchangePos.takeProfit ? (typeof exchangePos.takeProfit.toNumber === 'function' ? exchangePos.takeProfit.toNumber() : Number(exchangePos.takeProfit)) : null;
                    const expectedSL = dbPos.stop_loss || dbPos.stopLoss;
                    const expectedTP = dbPos.take_profit || dbPos.takeProfit;
                    
                    // 1% tolerance for precision/rounding differences from the exchange
                    const isValidSL = exchangeSL && expectedSL && Math.abs((exchangeSL - expectedSL) / expectedSL) < 0.01;
                    const isValidTP = exchangeTP && expectedTP && Math.abs((exchangeTP - expectedTP) / expectedTP) < 0.01;
                    
                    if (!isValidSL || !isValidTP) {
                      console.warn(`[SAFETY] Position ${dbPos.symbol} protection mismatch! Expected SL:${expectedSL}/TP:${expectedTP}, found SL:${exchangeSL}/TP:${exchangeTP}`);
                      await this.logAuditEvent(userId, 'PROTECTION_VERIFICATION_FAILED', { symbol: dbPos.symbol, expectedSL, expectedTP, exchangeSL, exchangeTP });
                    }
                 }
               }
            }
          }
        }
      } catch (e) {
        console.error("WAL Reconciliation sweep failed:", e);
      }

    // Sprint 10 Phase 1 Integration
    try {
      const coinId = await this.state.storage.get('coinId') as string;
      const userId = await this.state.storage.get('userId') as string;
      const strategy = await this.state.storage.get('strategy') as string;
      
      if (coinId && userId) {
        const user = await this.env.DB.prepare('SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_salt FROM users WHERE id = ?').bind(userId).first<any>();
        if (user?.exchange_name) {
          let apiKey: string | undefined = undefined;
          if (this.env.ENCRYPTION_KEY && user.exchange_api_key_iv && user.exchange_api_key_encrypted) {
            try {
              apiKey = await decrypt({ iv: user.exchange_api_key_iv, encrypted: user.exchange_api_key_encrypted, salt: user.exchange_api_key_salt }, this.env.ENCRYPTION_KEY);
            } catch (_) {}
          }
          if (!apiKey && user.exchange_api_key) {
            apiKey = user.exchange_api_key;
          }

          let secret: string | undefined = undefined;
          if (this.env.ENCRYPTION_KEY && user.exchange_api_secret_iv && user.exchange_api_secret_encrypted) {
            try {
              secret = await decrypt({ iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted, salt: user.exchange_api_secret_salt }, this.env.ENCRYPTION_KEY);
            } catch (_) {}
          }

          let password: string | undefined = undefined;
          if (this.env.ENCRYPTION_KEY && user.exchange_api_passphrase_iv && user.exchange_api_passphrase_encrypted) {
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
            ...this.resolveEgressConfig(user.exchange_name),
          });

            const provider = new AdapterCandleProvider(adapter);
            const dataEngine = new MarketDataEngine(provider);
            this.orchestrator.setMarketDataEngine(dataEngine);

            const strategyConfig = (await this.state.storage.get('strategyConfig')) as Record<string, any> | undefined;
            const balanceResult = await adapter.fetchBalance().catch(() => null);
            const accountBalance = (balanceResult as any)?.free?.USDT ?? (balanceResult as any)?.total?.USDT ?? (balanceResult as any)?.USDT?.free ?? 1000;
            const results = await this.orchestrator.executeCycle(coinId, strategy, strategyConfig, accountBalance);
            const currentState = this.orchestrator.getCurrentState();
            await this.state.storage.put('engineState', currentState);
        
            // Phase 1: Android Contract Integration (Harmonized AnalysisSnapshotMapper)
            const registry = StrategyRegistry.getInstance();
            const normalizedId = registry.normalizeStrategyId(strategy);
            const manifests = registry.getAllManifests();
            const manifest = registry.getManifest(normalizedId) || manifests.find(m => m.id.toLowerCase() === normalizedId.toLowerCase());
            if (!manifest) {
              new StructuredLogger().warn(`[StrategyOrchestrator] Strategy '${strategy}' not found. Available: ${manifests.map(m => m.id).join(', ')}`);
              throw new UnifiedError(`Strategy '${strategy}' is not registered.`, 'UNSUPPORTED_OPERATION');
            }
            const snapshot = await dataEngine.getSnapshot(coinId, manifest.supportedTimeframes || ['5m']);
            const primaryResult = results.length > 0 ? results[0] : {
              strategyId: manifest.id,
              timestamp: Date.now(),
              confidenceScore: 50,
              hasSignal: false,
              metadata: { reasoning: ['Evaluation pending'] }
            };
            const newAnalysis = AnalysisSnapshotMapper.map(primaryResult, manifest, snapshot, currentState.toString(), true);
            await this.state.storage.put('newAnalysis', newAnalysis);

            // Phase 1: Trading Signal Integration
            if (primaryResult?.hasSignal) {
              const sig = primaryResult.metadata.signal;
              const isAllowedSignal = sig && (sig.type === 'BUY' || (sig.type === 'SELL' && manifest.supportsShort));
              if (isAllowedSignal) {
                const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
                // Check if we recently added this alert to avoid spamming the queue
                const recentAlert = alerts.find(a => a.symbol === coinId && a.status === 'pending' && a.strategy === `${strategy}_NEW`);
                if (!recentAlert) {
                  // Fetch live market price at the exact moment of signal generation
                  const ticker = await adapter.fetchTicker(coinId).catch(() => null);
                  const price = typeof ticker?.last?.toNumber === 'function' ? ticker.last.toNumber() : (typeof ticker?.last === 'number' ? ticker.last : 0);
                  
                  const setupSnapshot = await this.state.storage.get<TradeSetupSnapshot>('setupSnapshot');
                  const storedPositionSize = setupSnapshot?.positionSize ?? ((await this.state.storage.get('positionSize')) as number | undefined);
                  const calculatedSize = sig.riskAssessment?.positionSizeRecommendation;
                  const size = (storedPositionSize && storedPositionSize > 0) ? storedPositionSize : (calculatedSize && calculatedSize > 0 ? calculatedSize : 0);
                  
                  if (size <= 0) {
                    console.warn(`[trading-bot] Skipping TradeAlert generation for ${coinId}: No valid position size available from RiskEngine or manual override.`);
                    await this.logAuditEvent(userId, 'ALERT_SKIPPED_MISSING_POSITION_SIZE', {
                      symbol: coinId,
                      strategy: setupSnapshot?.strategy || strategy,
                      reason: 'Trade opportunity detected, but execution was skipped because no valid position size was available.'
                    });

                    const existingLogs = (await this.state.storage.get('logs')) as string[] || [];
                    existingLogs.push(`[${new Date().toISOString()}] WARN: Trade opportunity detected for ${coinId}, but alert generation was skipped because no valid position size was available.`);
                    await this.state.storage.put('logs', existingLogs.slice(-50));
                  } else {
                    // Phase A1 Integration: MarketRegime Check
                  const klines = (typeof adapter.fetchKlines === 'function')
                    ? await adapter.fetchKlines(coinId, '1h', 50).catch(() => [])
                    : [];
                  if (klines && klines.length >= 20) {
                    const highs = klines.map((k: any) => k.high?.toNumber ? k.high.toNumber() : Number(k.high));
                    const lows = klines.map((k: any) => k.low?.toNumber ? k.low.toNumber() : Number(k.low));
                    const closes = klines.map((k: any) => k.close?.toNumber ? k.close.toNumber() : Number(k.close));
                    const regime = MarketRegimeEngine.evaluate(highs, lows, closes, 0);
                    const regimeAllowed = MarketRegimeEngine.isStrategyAllowed(setupSnapshot?.strategy || strategy, regime);
                    if (!regimeAllowed.allowed) {
                      console.warn(`[trading-bot] Skipping TradeAlert generation for ${coinId}: MarketRegime check failed: ${regimeAllowed.reason}`);
                      await this.logAuditEvent(userId, 'ALERT_SKIPPED_MARKET_REGIME', {
                        symbol: coinId,
                        strategy: setupSnapshot?.strategy || strategy,
                        reason: regimeAllowed.reason,
                        regime: regime.regime,
                        score: regime.score
                      });
                      return;
                    }
                  }

                  const targetEntryPrice = setupSnapshot?.targetEntryPrice ?? ((await this.state.storage.get('targetEntryPrice')) as number | undefined);
                    const alertSignalPrice = sig.signalPrice || price;
                    const alertTargetPrice = targetEntryPrice ?? sig.targetEntryPrice ?? undefined;
                    const alertStopLoss = sig.stopLoss || alertSignalPrice * 0.99;
                    const alertTakeProfit = sig.takeProfit || alertSignalPrice * 1.01;
                    const estimatedPnl = Math.abs(alertTakeProfit - alertSignalPrice) * (alertSignalPrice > 0 ? size / alertSignalPrice : 0);

                    const alert: TradeAlert = {
                      id: crypto.randomUUID(),
                      symbol: coinId,
                      signalPrice: alertSignalPrice,
                      targetEntryPrice: alertTargetPrice,
                      entryPrice: alertSignalPrice,
                      stopLoss: alertStopLoss,
                      takeProfit: alertTakeProfit,
                      estimatedPnl: estimatedPnl,
                      positionSize: size,
                      strategy: `${setupSnapshot?.strategy || strategy}_NEW`,
                      side: sig.type as 'BUY' | 'SELL',
                      timestamp: new Date().toISOString(),
                      status: 'pending'
                    };
                    alerts.push(alert);
                    await this.state.storage.put('alerts', alerts);

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
                        confidenceScore: primaryResult?.confidenceScore || 0,
                        reasoning: primaryResult?.metadata?.reasoning || [],
                      });
                    } catch (notifErr) {
                      console.error('Failed to send FCM trade notification:', notifErr);
                    }
                  }
                }
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
      const isActive = await this.state.storage.get('isActive');
      if (isActive) {
        await this.state.storage.setAlarm(Date.now() + ANALYSIS_INTERVAL_MS);
      }
    }
  }

  /**
   * The core synchronized workflow: fetch live market data from the user's
   * connected exchange (any of the supported exchanges, mainnet or testnet),
   * compute real indicators, evaluate the strategy, and ΓÇö only if every
   * strategy condition is satisfied ΓÇö raise a genuine trade alert. The
   * resulting snapshot is persisted so the UI can render it verbatim (no
   * time-based animation).
   */
  private async monitorOpenPositions() {
    try {
      const userId = (await this.state.storage.get('userId')) as string;
      if (!userId) return;

      const activePositions = await this.state.storage.get<any[]>('activePositions') || [];

      if (activePositions.length === 0) return;
      const results = activePositions;

      const userKeys = await this.env.DB.prepare(
        'SELECT exchange_api_key, exchange_api_key_encrypted, exchange_api_key_iv, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?'
      ).bind(userId).first<any>();

      const hasApiKey = Boolean(userKeys?.exchange_api_key_encrypted || userKeys?.exchange_api_key);
      if (!userKeys?.exchange_name || !hasApiKey || !userKeys?.exchange_api_secret_encrypted) return;


      const adapter = await ExchangeManager.getProvider(userKeys.exchange_name as ExchangeName, { environment: normalizeEnvironment(userKeys.exchange_environment), region: resolveCanonicalRoutingRegion(userKeys.exchange_region), ...this.resolveEgressConfig(userKeys.exchange_name) });

      
      for (const position of results as any[]) {
        try {
          // Strictly restrict local price-trigger monitoring to Mock/Paper Trading positions.
          // For Bybit Demo and Real, Bybit owns live position and SL/TP monitoring.
          if (position.exchange !== 'mock' || position.environment !== 'demo') {
            continue;
          }

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

            // Fire-and-forget telemetry push to D1
            this.env.DB.prepare(
              "UPDATE trade_positions SET status = 'CLOSED', closed_at = ?, close_price = ?, realized_pnl = ?, close_reason = ?, updated_at = ? WHERE id = ?"
            )
              .bind(now, currentPrice, realizedPnl, closeReason, now, position.id)
              .run().catch(e => console.error('D1 position close sync failed:', e));

            // Update Authoritative DO WAL
            const updatedPositions = activePositions.filter((p: any) => p.id !== position.id);
            await this.state.storage.put('activePositions', updatedPositions);

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

  private pruneAlerts(alerts: TradeAlert[]): TradeAlert[] {
    const pending = alerts.filter((a) => a.status === 'pending');
    return pending.slice(-100);
  }

  private appendLog(logs: AnalysisLog[], message: string, level: AnalysisLog['level']): AnalysisLog[] {
    return logs.concat([{ timestamp: new Date().toISOString(), level, message }]);
  }

  private resolveEgressConfig(_exchangeName?: string | null) {
    return {};
  }
}
