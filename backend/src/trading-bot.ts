import { Env } from './index';
import { getExchangeAdapter, ExchangeName, ExchangeEnvironment, ExchangeRegion, MarketTicker, normalizeQuantity, IExchangeAdapter } from './exchanges';
import { type Kline } from './exchanges/types';
import { ReconciliationEngine } from './exchanges/ReconciliationEngine';
import { decrypt } from './crypto';
import { sendTradeNotification } from './handlers/notifications';
import { StrategyOrchestrator, EngineState, MarketDataEngine, ICandleProvider, NormalizedCandle, Timeframe } from './engine';
import { ScalperV2Strategy } from './engine/strategies/scalper-v2/ScalperV2Strategy';
import { EngineAPIService } from './api/engine';
import { StrategyRegistry } from './engine/strategies/StrategyRegistry';
/**
 * Normalize an untrusted environment value into a valid ExchangeEnvironment,
 * defaulting to "mainnet" unless "testnet" is explicitly stored.
 */
function normalizeEnvironment(value: unknown): ExchangeEnvironment {
  return value === 'testnet' ? 'testnet' : 'mainnet';
}

/**
 * Normalize an untrusted region value into a valid ExchangeRegion, defaulting
 * to "india" so Delta Exchange India accounts reach the India domain even if
 * no region was previously persisted.
 */
function normalizeRegion(value: unknown): ExchangeRegion {
  return value === 'global' || value === 'india' ? value : 'india';
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

interface AnalysisSnapshot {
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

interface ConfluenceResult {
  score: number;
  alignment: 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE';
  timeframes: TimeframeAnalysis[];
  primarySignal: 'BUY' | 'SELL' | 'HOLD';
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

export function toMetrics(ticker: MarketTicker): Metrics {
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
  ticker: MarketTicker,
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
    
    // Risk-based position sizing
    const slDistancePct = (atrMultiplier * 1.0) / entry;
    const calculatedPositionSize = slDistancePct > 0 ? riskAmount / slDistancePct : riskAmount * 10;
    const positionSize = Math.max(calculatedPositionSize, minNotional);
    
    const estimatedPnl = Math.abs((takeProfit - entry) / entry) * positionSize;
    opportunity = { symbol: ticker.symbol, entryPrice: entry, stopLoss, takeProfit, estimatedPnl, positionSize, side: ez.side };
  }

  return { checkpoints, total, passed, progress, confidence, conditionsMet, opportunity };
}

/**
 * Lightweight, fully real evaluation used to populate the "scanning coins" row
 * for comparison symbols. Reuses the strategy's universal filters
 * (volume / volatility / momentum) so every number on the screen is genuine.
 */
function quickEvaluate(ticker: MarketTicker, config: StrategyConfig): { progress: number; status: ScanCandidate['status'] } {
  const m = toMetrics(ticker);
  let passed = 0;
  const total = 3;
  if (m.volume >= config.volumeThreshold) passed++;
  if (m.rangePercent >= config.rangeThreshold) passed++;
  if (Math.abs(m.change24h) >= config.momentumThreshold) passed++;
  const progress = Math.round((passed / total) * 100);
  return { progress, status: progress >= 100 ? 'queued' : 'scanning' };
}

function normalizeSymbol(symbol: string): string {
  return symbol.replace('/USDT', '').replace('USDT', '').toUpperCase();
}

/**
 * AdapterCandleProvider acts as a bridge between the isolated MarketDataEngine
 * and the legacy ExchangeAdapters.
 */
class AdapterCandleProvider implements ICandleProvider {
  constructor(private adapter: IExchangeAdapter) {}

  async fetchCandles(symbol: string, timeframe: Timeframe, limit: number = 100): Promise<NormalizedCandle[]> {
    // We map internal timeframes (1m, 3m, 5m, 15m, 30m, 1h, 4h) directly 
    // to the adapter's expected intervals. 
    // The legacy `fetchKlines` expects interval as string.
    const klines = await this.adapter.fetchKlines(symbol, timeframe, limit);
    return klines.map((k: Kline) => ({
      timestamp: k.openTime,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume
    }));
  }

  async fetchTicker(symbol: string): Promise<MarketTicker | null> {
    return this.adapter.fetchTicker(symbol);
  }
}

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
        
        const user = await this.env.DB.prepare('SELECT exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?').bind(userId).first<{ exchange_name: string | null; exchange_environment: string | null; exchange_region: string | null }>();
        if (user?.exchange_name) {
          const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment), normalizeRegion(user.exchange_region));
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
        if (!isActive) {
          const logs = (await this.state.storage.get('logs')) as AnalysisLog[] | undefined;
          return new Response(JSON.stringify({
            isActive: false,
            strategy: null,
            coinId: null,
            exchange: null,
            environment: null,
            scanningProgress: 0,
            etaSeconds: 0,
            confluenceScore: 0,
            alignment: 'NONE',
            primarySignal: 'HOLD',
            timeframes: [],
            coinsCurrentlyScanning: [],
            nearMatches: [],
            checkpoints: [],
            logs: logs ? logs.slice(-50) : [],
            lastAnalysisAt: 0,
            opportunityDetected: false,
          } as AnalysisSnapshot), { status: 200 });
        }

        
          const newAnalysis = await this.state.storage.get('newAnalysis');
          if (newAnalysis) {
             return new Response(JSON.stringify(newAnalysis), { status: 200 });
          }
          return new Response(JSON.stringify({ error: "No new engine analysis available yet." }), { status: 404 });
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
        if (this.env.GLOBAL_TRADING_HALT === 'true') {
          return new Response(JSON.stringify({ error: 'GLOBAL_TRADING_HALT is active. All trading is safely suspended.' }), { status: 503 });
        }

        const safeMode = await this.state.storage.get('safeMode');
        if (safeMode) {
          return new Response(JSON.stringify({ error: 'Safe Mode is active. New trade execution is temporarily disabled pending manual review.' }), { status: 403 });
        }

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
              'SELECT exchange_api_key, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?'
            ).bind(userId).first<{ exchange_api_key: string; exchange_api_secret_iv: string; exchange_api_secret_encrypted: string; exchange_name: string; exchange_environment: string | null; exchange_region: string | null }>();

            if (!userKeys?.exchange_api_key || !userKeys?.exchange_api_secret_encrypted) {
              return new Response(JSON.stringify({ error: 'User has not configured their exchange API keys.' }), { status: 400 });
            }

            const decryptedSecret = await decrypt(
              { iv: userKeys.exchange_api_secret_iv, encrypted: userKeys.exchange_api_secret_encrypted },
              this.env.ENCRYPTION_KEY,
            );

            const adapter = getExchangeAdapter(userKeys.exchange_name as ExchangeName, normalizeEnvironment(userKeys.exchange_environment), normalizeRegion(userKeys.exchange_region));
            const coinId = (await this.state.storage.get('coinId')) as string;

            const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
            const pending = alerts.filter((a) => a.status === 'pending' || a.status === 'acknowledged');
            if (pending.length === 0) {
              return new Response(JSON.stringify({ error: 'No pending alert to execute.' }), { status: 400 });
            }
            const target = pending[pending.length - 1];
            const side: 'BUY' | 'SELL' = target.side || 'BUY';
            const orderSymbol = coinId; // Strict lock to the active trading instrument
            const clientOrderId = target.id; // Feature 2: Idempotent Execution

            target.status = 'submitted';
            await this.state.storage.put('alerts', this.pruneAlerts(alerts));
            await this.logAuditEvent(userId, 'TRADE_SUBMITTED', { symbol: orderSymbol, side, clientOrderId, strategy: target.strategy, entryPrice: target.entryPrice });

            let orderResult: any = { success: true, message: 'Trade executed (simulated).', orderId: clientOrderId };
            let orderType: 'MARKET' | 'LIMIT' = 'MARKET';
            let limitPrice: number | undefined = undefined;

            try {
              if (adapter.placeOrder) {
                const ticker = await adapter.fetchTicker(orderSymbol);
                const currentPrice = ticker?.price || target.signalPrice || target.entryPrice;
                const targetPrice = target.targetEntryPrice || target.signalPrice || target.entryPrice;
                
                // Hybrid Order Selection: If target price differs by > 0.05% from current live price, use LIMIT order
                const deltaPercent = currentPrice > 0 ? (Math.abs(targetPrice - currentPrice) / currentPrice) : 0;
                if (target.targetEntryPrice && deltaPercent > 0.0005) {
                  orderType = 'LIMIT';
                  limitPrice = target.targetEntryPrice;
                }

                const refPrice = limitPrice || currentPrice;
                const rawQty = target.positionSize > 0 && refPrice > 0
                  ? target.positionSize / refPrice
                  : undefined;
                  
                if (target.positionSize < (ticker?.minNotional || 0)) {
                  throw new Error(`Order size ${target.positionSize} is below exchange minimum notional of ${ticker?.minNotional}`);
                }
                
                const qty = rawQty != null && ticker
                  ? normalizeQuantity(rawQty, ticker.lotSize, ticker.minOrderQty, ticker.maxOrderQty)
                  : rawQty;
                  
                orderResult = await adapter.placeOrder(
                  orderSymbol,
                  side,
                  userKeys.exchange_api_key,
                  decryptedSecret,
                  qty,
                  clientOrderId,
                  orderType,
                  limitPrice,
                  target.stopLoss,
                  target.takeProfit
                );

                // Binance Post-Fill Native OCO Creation
                if (orderResult.success && userKeys.exchange_name === 'binance' && adapter.placeOcoOrder && orderResult.status === 'filled') {
                  const ocoSide = side === 'BUY' ? 'SELL' : 'BUY';
                  const ocoResult = await adapter.placeOcoOrder(
                    orderSymbol,
                    ocoSide,
                    userKeys.exchange_api_key,
                    decryptedSecret,
                    orderResult.quantity || qty || 0.001,
                    target.takeProfit,
                    target.stopLoss,
                    `oco_${clientOrderId}`
                  ).catch((err: any) => ({ success: false, message: err.message }));

                  if (ocoResult.success && 'ocoGroupId' in ocoResult) {
                    const res = orderResult as any;
                    res.ocoGroupId = (ocoResult as any).ocoGroupId;
                    res.tpOrderId = (ocoResult as any).tpOrderId;
                    res.slOrderId = (ocoResult as any).slOrderId;
                    res.protectionMode = 'NATIVE_OCO';
                  }
                }
              }
            } catch (e: any) {
              orderResult = { success: false, message: e.message || 'Trade execution failed' };
            }

            target.status = orderResult.success ? 'executed' : 'failed';
            await this.state.storage.put('alerts', this.pruneAlerts(alerts));
            
            if (orderResult.success) {
              const refPrice = target.targetEntryPrice || target.signalPrice || target.entryPrice;
              let averageFillPrice = orderResult.price;
              if (!averageFillPrice || averageFillPrice <= 0) {
                const fallbackTicker = await adapter.fetchTicker(orderSymbol).catch(() => null);
                averageFillPrice = fallbackTicker?.price || refPrice;
              }

              await this.logAuditEvent(userId, 'TRADE_FILLED', { symbol: orderSymbol, side, orderId: orderResult.orderId, price: averageFillPrice, quantity: orderResult.quantity, strategy: target.strategy });
              await this.state.storage.put('tradeActive', true);
              await this.state.storage.put('tradeEntryTimestamp', new Date().toISOString());
              await this.state.storage.put('lastSuccessfulTradeAt', Date.now());

              const positionId = crypto.randomUUID();
              const now = new Date().toISOString();
              const initialStatus = orderResult.status === 'open' ? 'PENDING_ENTRY' : 'OPEN';
              
              const positionData = {
                  id: positionId,
                  userId,
                  orderSymbol,
                  side,
                  entryPrice: averageFillPrice,
                  targetEntryPrice: target.targetEntryPrice || null,
                  signalPrice: target.signalPrice || target.entryPrice,
                  averageFillPrice: averageFillPrice,
                  quantity: orderResult.quantity || 0,
                  stopLoss: target.stopLoss,
                  takeProfit: target.takeProfit,
                  exchangeName: userKeys.exchange_name,
                  environment: userKeys.exchange_environment || 'mainnet',
                  strategy: target.strategy,
                  orderId: orderResult.orderId || null,
                  entryExchangeOrderId: orderResult.exchangeOrderId || orderResult.orderId || null,
                  tpExchangeOrderId: orderResult.tpOrderId || null,
                  slExchangeOrderId: orderResult.slOrderId || null,
                  ocoGroupId: orderResult.ocoGroupId || null,
                  protectionMode: orderResult.protectionMode || 'ATTACHED_TPSL',
                  orderType: orderType,
                  limitPrice: limitPrice || null,
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
                const targetPrice = target.targetEntryPrice || target.signalPrice || target.entryPrice;
                const slippagePercent = targetPrice > 0 ? (Math.abs(averageFillPrice - targetPrice) / targetPrice) * 100 : 0;
                await this.env.DB.prepare(
                  `INSERT INTO trade_execution_audit (
                    id, alert_id, user_id, symbol, strategy, target_entry_price, signal_price, execution_price, average_fill_price, stop_loss, take_profit, slippage_percent, fill_timestamp, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                  .bind(
                    crypto.randomUUID(),
                    target.id,
                    userId,
                    orderSymbol,
                    target.strategy,
                    target.targetEntryPrice || null,
                    target.signalPrice || target.entryPrice,
                    refPrice,
                    averageFillPrice,
                    target.stopLoss,
                    target.takeProfit,
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

            return new Response(JSON.stringify({ success: orderResult.success, message: orderResult.message, side, order: orderResult }), { status: 200 });
          } finally {
            this.isExecutingTrade = false;
            await this.state.storage.put('isExecutingTrade', false);
          }
        });
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
              const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment), normalizeRegion(user.exchange_region));
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

        const safeMode = (await this.state.storage.get('safeMode')) || false;
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

      // Phase 3.3.2: Reconciliation Sweep (Run roughly every hour or based on config)
      const lastReconciliationAt = (await this.state.storage.get('lastReconciliationAt')) as number | undefined;
      const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;
      if (!lastReconciliationAt || Date.now() - lastReconciliationAt > RECONCILIATION_INTERVAL_MS) {
         try {
           const userId = await this.state.storage.get('userId') as string;
           if (userId) {
             const userKeys = await this.env.DB.prepare('SELECT exchange_api_key, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?').bind(userId).first<{ exchange_api_key: string; exchange_api_secret_iv: string; exchange_api_secret_encrypted: string; exchange_name: string; exchange_environment: string | null; exchange_region: string | null }>();
             if (userKeys?.exchange_name && userKeys.exchange_api_secret_encrypted) {
               const decryptedSecret = await decrypt({ iv: userKeys.exchange_api_secret_iv, encrypted: userKeys.exchange_api_secret_encrypted }, this.env.ENCRYPTION_KEY);
               const adapter = getExchangeAdapter(userKeys.exchange_name as ExchangeName, normalizeEnvironment(userKeys.exchange_environment), normalizeRegion(userKeys.exchange_region));
               
               // Override secret for engine calls
               userKeys.exchange_api_secret_encrypted = decryptedSecret;
               
               const reconciliationEngine = new ReconciliationEngine(this.state.storage, this.env, userId, adapter, userKeys);
               await reconciliationEngine.runReconciliationSweep();
             }
           }
         } catch (e) {
           console.error("Reconciliation sweep failed:", e);
         }
      }

      // Sprint 10 Phase 1 Integration
      try {
        const coinId = await this.state.storage.get('coinId') as string;
        const userId = await this.state.storage.get('userId') as string;
        const strategy = await this.state.storage.get('strategy') as string;
        
        if (coinId && userId) {
            const user = await this.env.DB.prepare('SELECT exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?').bind(userId).first<{ exchange_name: string | null; exchange_environment: string | null; exchange_region: string | null }>();
            if (user?.exchange_name) {
              const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment), normalizeRegion(user.exchange_region));
              const provider = new AdapterCandleProvider(adapter);
              const dataEngine = new MarketDataEngine(provider);
              this.orchestrator.setMarketDataEngine(dataEngine);
            }

            const strategyConfig = await this.state.storage.get('strategyConfig');
            const results = await this.orchestrator.executeCycle(coinId, strategy, strategyConfig);
            const currentState = this.orchestrator.getCurrentState();
            await this.state.storage.put('engineState', currentState);
            
            // Phase 1: Android Contract Integration
            const primaryResult = results.length > 0 ? results[0] : undefined;
            const newAnalysis = this.engineApi.transform(currentState, coinId, primaryResult);
            await this.state.storage.put('newAnalysis', newAnalysis);

            // Phase 1: Trading Signal Integration
            if (primaryResult?.hasSignal) {
              const sig = primaryResult.metadata.signal;
              if (sig && (sig.type === 'BUY' || sig.type === 'SELL')) {
                const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
                // Check if we recently added this alert to avoid spamming the queue
                const recentAlert = alerts.find(a => a.symbol === coinId && a.status === 'pending' && a.strategy === `${strategy}_NEW`);
                if (!recentAlert) {
                  // Fetch live market price at the exact moment of signal generation
                  const ticker = user?.exchange_name ? await getExchangeAdapter(user.exchange_name as ExchangeName, 'mainnet', 'global').fetchTicker(coinId).catch(() => null) : null;
                  const price = ticker?.price || 0;
                  
                  const storedPositionSize = (await this.state.storage.get('positionSize')) as number | undefined;
                  const size = storedPositionSize ?? 0;
                  
                  const targetEntryPrice = (await this.state.storage.get('targetEntryPrice')) as number | undefined;
                  const alertSignalPrice = sig.signalPrice || price;
                  const alertTargetPrice = targetEntryPrice ?? sig.targetEntryPrice ?? undefined;

                  const alert: TradeAlert = {
                    id: crypto.randomUUID(),
                    symbol: coinId,
                    signalPrice: alertSignalPrice,
                    targetEntryPrice: alertTargetPrice,
                    entryPrice: alertSignalPrice,
                    stopLoss: sig.stopLoss || alertSignalPrice * 0.99,
                    takeProfit: sig.takeProfit || alertSignalPrice * 1.01,
                    estimatedPnl: 0,
                    positionSize: size,
                    strategy: `${strategy}_NEW`,
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
                    });
                  } catch (notifErr) {
                    console.error('Failed to send FCM trade notification:', notifErr);
                  }
                }
              }
            }
        }
      } catch (err) {
        console.error('Orchestrator cycle failed:', err);
      }

      const lastPositionCheckAt = (await this.state.storage.get('lastPositionCheckAt')) as number | undefined;
      if (!lastPositionCheckAt || Date.now() - lastPositionCheckAt > POSITION_CHECK_INTERVAL_MS) {
        await this.monitorOpenPositions();
        await this.state.storage.put('lastPositionCheckAt', Date.now());
      }
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
   * compute real indicators, evaluate the strategy, and — only if every
   * strategy condition is satisfied — raise a genuine trade alert. The
   * resulting snapshot is persisted so the UI can render it verbatim (no
   * time-based animation).
   */
  private async monitorOpenPositions() {
    try {
      const userId = (await this.state.storage.get('userId')) as string;
      if (!userId) return;

      const { results } = await this.env.DB.prepare(
        "SELECT * FROM trade_positions WHERE user_id = ? AND status = 'OPEN'"
      )
        .bind(userId)
        .all();

      if (!results || results.length === 0) return;

      const userKeys = await this.env.DB.prepare(
        'SELECT exchange_api_key, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?'
      ).bind(userId).first<{ exchange_api_key: string; exchange_api_secret_iv: string; exchange_api_secret_encrypted: string; exchange_name: string; exchange_environment: string | null; exchange_region: string | null }>();

      if (!userKeys?.exchange_name || !userKeys?.exchange_api_key || !userKeys?.exchange_api_secret_encrypted) return;

      const decryptedSecret = await decrypt(
        { iv: userKeys.exchange_api_secret_iv, encrypted: userKeys.exchange_api_secret_encrypted },
        this.env.ENCRYPTION_KEY,
      );

      const adapter = getExchangeAdapter(userKeys.exchange_name as ExchangeName, normalizeEnvironment(userKeys.exchange_environment), normalizeRegion(userKeys.exchange_region));
      
      // Feature 7: Automatic Synchronization of Open Positions
      let exchangePositions: any[] = [];
      if (adapter.fetchPositions) {
        const posRes = await adapter.fetchPositions(userKeys.exchange_api_key, decryptedSecret);
        if (posRes.success) {
          exchangePositions = posRes.result;
        }
      }

      for (const position of results as any[]) {
        try {
          const ticker = await adapter.fetchTicker(position.symbol);
          if (!ticker) continue;

          const currentPrice = ticker.price;
          let closeReason: string | null = null;

          // Check if position was closed externally on the exchange
          let isExternallyClosed = false;
          if (exchangePositions.length > 0) {
             const activeOnExchange = exchangePositions.find(p => p.symbol.includes(position.symbol) && p.size > 0);
             if (!activeOnExchange) {
               isExternallyClosed = true;
               closeReason = 'closed_externally';
             }
          }

          if (!isExternallyClosed) {
            if (position.side === 'BUY') {
              if (currentPrice <= position.stop_loss) {
                closeReason = 'stop_loss';
              } else if (currentPrice >= position.take_profit) {
                closeReason = 'take_profit';
              }
            } else {
              if (currentPrice >= position.stop_loss) {
                closeReason = 'stop_loss';
              } else if (currentPrice <= position.take_profit) {
                closeReason = 'take_profit';
              }
            }
          }

          if (closeReason) {
            const priceDiff = position.side === 'BUY'
              ? currentPrice - position.entry_price
              : position.entry_price - currentPrice;
            const realizedPnl = (priceDiff / position.entry_price) * position.quantity * position.entry_price;
            const now = new Date().toISOString();

            await this.env.DB.prepare(
              "UPDATE trade_positions SET status = 'CLOSED', closed_at = ?, close_price = ?, realized_pnl = ?, close_reason = ?, updated_at = ? WHERE id = ?"
            )
              .bind(now, currentPrice, realizedPnl, closeReason, now, position.id)
              .run();

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
}
