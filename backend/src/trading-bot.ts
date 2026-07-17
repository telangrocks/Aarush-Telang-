import { Env } from './index';
import { getExchangeAdapter, ExchangeName, ExchangeEnvironment, ExchangeRegion, MarketTicker, normalizeQuantity } from './exchanges';
import { type Kline } from './exchanges/types';
import { decrypt } from './crypto';
import { sendTradeNotification } from './handlers/notifications';

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
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  estimatedPnl: number;
  positionSize: number;
  strategy: string;
  side: 'BUY' | 'SELL';
  timestamp: string;
  status: 'pending' | 'acknowledged' | 'executed';
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
  positionSize: number,
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

export class TradingBot {
  state: DurableObjectState;
  env: Env;
  private isExecutingTrade = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/activate': {
        const { userId, coinId, strategy, positionSize } = await request.json<{ userId: string; coinId: string; strategy: string; positionSize?: number }>();
        await this.state.storage.put('isActive', true);
        await this.state.storage.put('coinId', coinId);
        await this.state.storage.put('strategy', strategy);
        await this.state.storage.put('userId', userId);
        await this.state.storage.put('positionSize', positionSize ?? 100);
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

        // Run the first real analysis immediately so the UI is never empty.
        await this.runAnalysisCycle();

        await this.state.storage.setAlarm(Date.now() + ANALYSIS_INTERVAL_MS);
        return new Response(JSON.stringify({ success: true, message: 'Bot activated.' }), { status: 200 });
      }
      case '/deactivate': {
        await this.state.storage.put('isActive', false);
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

        // The UI is a pure visualization of the most recent real analysis
        // cycle. If for some reason no snapshot exists yet, produce one now.
        let snapshot = (await this.state.storage.get('analysis')) as AnalysisSnapshot | undefined;
        if (!snapshot) {
          await this.runAnalysisCycle();
          snapshot = (await this.state.storage.get('analysis')) as AnalysisSnapshot | undefined;
        }

        return new Response(JSON.stringify(snapshot), { status: 200 });
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
        if (this.isExecutingTrade) {
          return new Response(JSON.stringify({ error: 'A trade execution is already in progress.' }), { status: 409 });
        }
        this.isExecutingTrade = true;

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
          const pending = alerts.filter((a) => a.status === 'pending');
          if (pending.length === 0) {
            return new Response(JSON.stringify({ error: 'No pending alert to execute.' }), { status: 400 });
          }
          const target = pending[pending.length - 1];
          const side: 'BUY' | 'SELL' = target.side || 'BUY';
          const orderSymbol = target.symbol || coinId;

          let orderResult: any = { success: true, message: 'Trade executed (simulated).' };
          try {
            if (adapter.placeOrder) {
              const ticker = await adapter.fetchTicker(orderSymbol);
              const rawQty = target.positionSize > 0 && target.entryPrice > 0
                ? target.positionSize / target.entryPrice
                : undefined;
              const qty = rawQty != null && ticker
                ? normalizeQuantity(rawQty, ticker.lotSize, ticker.minOrderQty, ticker.maxOrderQty)
                : rawQty;
              orderResult = await adapter.placeOrder(orderSymbol, side, userKeys.exchange_api_key, decryptedSecret, qty);
            }
          } catch (e: any) {
            orderResult = { success: false, message: e.message || 'Trade execution failed' };
          }

          target.status = 'executed';
          await this.state.storage.put('alerts', this.pruneAlerts(alerts));
          await this.state.storage.put('tradeActive', true);
          await this.state.storage.put('tradeEntryTimestamp', new Date().toISOString());

          if (orderResult.success) {
            const positionId = crypto.randomUUID();
            const now = new Date().toISOString();
            await this.env.DB.prepare(
              `INSERT INTO trade_positions (
                id, user_id, symbol, side, entry_price, quantity, stop_loss, take_profit,
                status, exchange, environment, strategy, order_id, entry_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`
            )
              .bind(
                positionId,
                userId,
                orderSymbol,
                side,
                target.entryPrice,
                orderResult.quantity || 0,
                target.stopLoss,
                target.takeProfit,
                userKeys.exchange_name,
                userKeys.exchange_environment || 'mainnet',
                target.strategy,
                orderResult.orderId || null,
                now,
                now,
                now,
              )
              .run();
          }

          return new Response(JSON.stringify({ success: orderResult.success, message: orderResult.message, side, order: orderResult }), { status: 200 });
        } finally {
          this.isExecutingTrade = false;
        }
      }
      case '/stop-trade': {
        await this.state.storage.put('tradeActive', false);
        return new Response(JSON.stringify({ success: true, message: 'Trade stopped.' }), { status: 200 });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  async alarm() {
    const isActive = await this.state.storage.get('isActive');
    if (!isActive) return;

    // Every analysis cycle produces the real data the UI visualizes.
    await this.runAnalysisCycle();

    const lastPositionCheckAt = (await this.state.storage.get('lastPositionCheckAt')) as number | undefined;
    if (!lastPositionCheckAt || Date.now() - lastPositionCheckAt > POSITION_CHECK_INTERVAL_MS) {
      await this.monitorOpenPositions();
      await this.state.storage.put('lastPositionCheckAt', Date.now());
    }

    await this.state.storage.setAlarm(Date.now() + ANALYSIS_INTERVAL_MS);
  }

  /**
   * The core synchronized workflow: fetch live market data from the user's
   * connected exchange (any of the supported exchanges, mainnet or testnet),
   * compute real indicators, evaluate the strategy, and — only if every
   * strategy condition is satisfied — raise a genuine trade alert. The
   * resulting snapshot is persisted so the UI can render it verbatim (no
   * time-based animation).
   */
  private async runAnalysisCycle() {
    try {
      const coinId = (await this.state.storage.get('coinId')) as string;
      const strategy = (await this.state.storage.get('strategy')) as string;
      const userId = (await this.state.storage.get('userId')) as string;
      const config = getStrategyConfig(strategy);
      const baseSymbol = normalizeSymbol(coinId);

      // Resolve the live feed from the user's connected exchange and its
      // configured environment so the analysis is fully exchange-agnostic.
      // There is intentionally no default exchange: the bot uses whichever
      // exchange the user validated and connected.
      const user = await this.env.DB.prepare(
        'SELECT exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?',
      ).bind(userId).first<{ exchange_name: string | null; exchange_environment: string | null; exchange_region: string | null }>();

      if (!user?.exchange_name) {
        await this.persistAnalysis({
          isActive: true,
          strategy,
          coinId,
          exchange: null,
          environment: null,
          scanningProgress: 0,
          etaSeconds: Math.ceil(ANALYSIS_INTERVAL_MS / 1000),
          confluenceScore: 0,
          alignment: 'NONE',
          primarySignal: 'HOLD',
          timeframes: [],
          coinsCurrentlyScanning: [],
          nearMatches: [],
          checkpoints: [],
          logs: this.appendLog([], 'No exchange connected. Connect an exchange to start live analysis.', 'rejected'),
          lastAnalysisAt: Date.now(),
          opportunityDetected: false,
        });
        return;
      }

      const exchangeName = user.exchange_name as ExchangeName;
      const environment = normalizeEnvironment(user.exchange_environment);
      const region = normalizeRegion(user.exchange_region);
      const adapter = getExchangeAdapter(exchangeName, environment, region);

      const ticker = await adapter.fetchTicker(baseSymbol);
      if (!ticker) {
        await this.persistAnalysis({
          isActive: true,
          strategy,
          coinId,
          exchange: exchangeName,
          environment,
          scanningProgress: 0,
          etaSeconds: Math.ceil(ANALYSIS_INTERVAL_MS / 1000),
          confluenceScore: 0,
          alignment: 'NONE',
          primarySignal: 'HOLD',
          timeframes: [],
          coinsCurrentlyScanning: [],
          nearMatches: [],
          checkpoints: [],
          logs: this.appendLog([], `Live feed unavailable for ${baseSymbol} on ${exchangeName} (${environment}) — retrying next cycle.`, 'rejected'),
          lastAnalysisAt: Date.now(),
          opportunityDetected: false,
        });
        return;
      }

      const klines = await adapter.fetchKlines(baseSymbol, '1h', 100);
      const closes = klines.map((k: Kline) => k.close);
      const highs = klines.map((k: Kline) => k.high);
      const lows = klines.map((k: Kline) => k.low);
      const indicators = computeIndicators(closes);
      const atr = calculateAtr(highs, lows, closes, 14);
      const positionSize = (await this.state.storage.get('positionSize')) as number || 100;

      const evaluation = evaluateStrategy(ticker, indicators, strategy, atr, positionSize);
      const m = toMetrics(ticker);

      // Build the real "scanning coins" row from a live market snapshot.
      const candidates = await this.buildScanCandidates(adapter, baseSymbol, config);

      const nearMatches: NearMatch[] = [];
      if (evaluation.progress >= 60) {
        nearMatches.push({
          symbol: ticker.symbol,
          confidence: evaluation.confidence,
          estimatedEntry: evaluation.opportunity?.entryPrice ?? m.price,
          currentPrice: m.price,
          conditionsMet: evaluation.conditionsMet,
        });
      }

      // Run multi-timeframe analysis to get confluence score and per-TF breakdown.
      const confluence = await this.analyzeMultiTimeframe(adapter, baseSymbol, strategy, ticker);

      const prevLogs = (await this.state.storage.get('logs')) as AnalysisLog[] | undefined;
      let logs = prevLogs ?? [];
      if (evaluation.opportunity && confluence.score >= 75) {
        logs = this.appendLog(
          logs,
          `OPPORTUNITY DETECTED — ${evaluation.opportunity.side} ${ticker.symbol} @ $${evaluation.opportunity.entryPrice.toFixed(2)} (confluence ${confluence.score}%)`,
          'accepted',
        );
      } else if (evaluation.opportunity) {
        logs = this.appendLog(
          logs,
          `Single-TF opportunity found, but confluence only ${confluence.score}% — waiting for multi-TF alignment.`,
          'scanning',
        );
      } else {
        logs = this.appendLog(
          logs,
          `Analysis cycle: ${evaluation.passed}/${evaluation.total} conditions met for ${ticker.symbol} (RSI ${indicators.rsi?.toFixed(1) ?? 'n/a'}) — confluence ${confluence.score}%`,
          'scanning',
        );
      }

      await this.state.storage.put('logs', logs.slice(-50));

      const snapshot: AnalysisSnapshot = {
        isActive: true,
        strategy,
        coinId,
        exchange: exchangeName,
        environment,
        scanningProgress: evaluation.progress,
        etaSeconds: evaluation.opportunity
          ? 0
          : Math.max(0, Math.ceil((ANALYSIS_INTERVAL_MS - (Date.now() - (await this.lastAnalysisStamp()))) / 1000)),
        confluenceScore: confluence.score,
        alignment: confluence.alignment,
        primarySignal: confluence.primarySignal,
        timeframes: confluence.timeframes,
        coinsCurrentlyScanning: candidates,
        nearMatches,
        checkpoints: evaluation.checkpoints,
        logs: logs.slice(-50),
        lastAnalysisAt: Date.now(),
        opportunityDetected: evaluation.opportunity !== null && confluence.score >= 75,
      };

      // Only raise the alarm when BOTH single-TF strategy passes AND
      // multi-timeframe confluence is strong enough.
      if (evaluation.opportunity && confluence.score >= 75) {
        await this.raiseOpportunityAlert(userId, strategy, evaluation.opportunity);
      }

      await this.persistAnalysis(snapshot);
    } catch (e) {
      console.error('Analysis cycle error:', e);
      const prevLogs = (await this.state.storage.get('logs')) as AnalysisLog[] | undefined;
      await this.persistAnalysis({
        isActive: true,
        strategy: (await this.state.storage.get('strategy')) as string,
        coinId: (await this.state.storage.get('coinId')) as string,
        exchange: null,
        environment: null,
        scanningProgress: 0,
        etaSeconds: Math.ceil(ANALYSIS_INTERVAL_MS / 1000),
        confluenceScore: 0,
        alignment: 'NONE',
        primarySignal: 'HOLD',
        timeframes: [],
        coinsCurrentlyScanning: [],
        nearMatches: [],
        checkpoints: [],
        logs: this.appendLog(prevLogs ?? [], `Analysis error: ${(e as Error).message}`, 'rejected'),
        lastAnalysisAt: Date.now(),
        opportunityDetected: false,
      });
    }
  }

  private async lastAnalysisStamp(): Promise<number> {
    const stored = (await this.state.storage.get('analysis')) as AnalysisSnapshot | undefined;
    return stored?.lastAnalysisAt ?? Date.now();
  }

  private async persistAnalysis(snapshot: AnalysisSnapshot) {
    await this.state.storage.put('analysis', snapshot);
  }

  private async buildScanCandidates(
    adapter: ReturnType<typeof getExchangeAdapter>,
    baseSymbol: string,
    config: StrategyConfig,
  ): Promise<ScanCandidate[]> {
    const candidates: ScanCandidate[] = [];

    const primary = await adapter.fetchTicker(baseSymbol);
    if (primary) {
      const q = quickEvaluate(primary, config);
      candidates.push({
        symbol: `${primary.symbol}/USDT`,
        price: primary.price,
        progress: q.progress,
        status: q.status,
      });
    }

    const comparison = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA'].filter((s) => s !== baseSymbol);
    for (let i = 0; i < Math.min(4, comparison.length); i++) {
      try {
        const t = await adapter.fetchTicker(comparison[i]);
        if (!t) continue;
        const q = quickEvaluate(t, config);
        candidates.push({
          symbol: `${t.symbol}/USDT`,
          price: t.price,
          progress: q.progress,
          status: q.status,
        });
      } catch {
        /* skip unavailable symbol */
      }
    }

    return candidates;
  }

  private async raiseOpportunityAlert(
    userId: string,
    strategy: string,
    opportunity: NonNullable<StrategyEvaluation['opportunity']>,
  ) {
    const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
    const pending = alerts.filter((a) => a.status === 'pending');
    // Avoid duplicate alarms while a previous opportunity is still unhandled.
    if (pending.length > 0) return;

    const alertId = crypto.randomUUID();
    alerts.push({
      id: alertId,
      symbol: opportunity.symbol,
      entryPrice: opportunity.entryPrice,
      stopLoss: opportunity.stopLoss,
      takeProfit: opportunity.takeProfit,
      estimatedPnl: opportunity.estimatedPnl,
      positionSize: opportunity.positionSize,
      strategy,
      side: opportunity.side,
      timestamp: new Date().toISOString(),
      status: 'pending',
    });
    await this.state.storage.put('alerts', this.pruneAlerts(alerts));

    await sendTradeNotification(this.env, userId, alertId, {
      symbol: opportunity.symbol,
      entryPrice: opportunity.entryPrice,
      stopLoss: opportunity.stopLoss,
      takeProfit: opportunity.takeProfit,
      estimatedPnl: opportunity.estimatedPnl,
      side: opportunity.side,
      strategy,
    });
  }

  private async analyzeMultiTimeframe(adapter: ReturnType<typeof getExchangeAdapter>, coinId: string, strategy: string, _ticker: MarketTicker): Promise<ConfluenceResult> {
    const timeframes = [
      { timeframe: '1H', interval: '60', weight: 0.40 },
      { timeframe: '30m', interval: '30', weight: 0.25 },
      { timeframe: '15m', interval: '15', weight: 0.20 },
      { timeframe: '5m', interval: '5', weight: 0.15 },
    ];

    const results: TimeframeAnalysis[] = [];
    let totalScore = 0;
    let totalWeight = 0;

    for (const tf of timeframes) {
      try {
        const klines = await adapter.fetchKlines(coinId, tf.interval, 50);
        if (klines.length < 20) {
          results.push({
            timeframe: tf.timeframe,
            interval: tf.interval,
            trend: 'NEUTRAL',
            momentum: 'NEUTRAL',
            volumeProfile: 'NORMAL',
            emaCross: 'NONE',
            rsi: 50,
            confidence: 0,
            reasoning: ['Insufficient data'],
          });
          continue;
        }

        const analysis = this.analyzeKlines(klines, strategy);
        results.push({
          timeframe: tf.timeframe,
          interval: tf.interval,
          ...analysis,
        });

        totalScore += analysis.confidence * tf.weight;
        totalWeight += tf.weight;
      } catch (e) {
        results.push({
          timeframe: tf.timeframe,
          interval: tf.interval,
          trend: 'NEUTRAL',
          momentum: 'NEUTRAL',
          volumeProfile: 'NORMAL',
          emaCross: 'NONE',
          rsi: 50,
          confidence: 0,
          reasoning: ['Analysis failed'],
        });
      }
    }

    const finalScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
    let alignment: ConfluenceResult['alignment'] = 'NONE';
    let primarySignal: ConfluenceResult['primarySignal'] = 'HOLD';

    if (finalScore >= 75) {
      alignment = 'STRONG';
      const bullishCount = results.filter(r => r.trend === 'BULLISH' && r.momentum !== 'OVERBOUGHT').length;
      const bearishCount = results.filter(r => r.trend === 'BEARISH' && r.momentum !== 'OVERSOLD').length;
      primarySignal = bullishCount > bearishCount ? 'BUY' : bearishCount > bullishCount ? 'SELL' : 'HOLD';
    } else if (finalScore >= 50) {
      alignment = 'MODERATE';
      primarySignal = 'HOLD';
    } else if (finalScore >= 25) {
      alignment = 'WEAK';
      primarySignal = 'HOLD';
    }

    return {
      score: finalScore,
      alignment,
      timeframes: results,
      primarySignal,
    };
  }

  private analyzeKlines(klines: Kline[], strategy: string): Omit<TimeframeAnalysis, 'timeframe' | 'interval'> {
    const closes = klines.map((k) => k.close);
    const volumes = klines.map((k) => k.volume);
    const highs = klines.map((k) => k.high);
    const lows = klines.map((k) => k.low);

    const ema20 = this.calculateEMA(closes, 20);
    const ema50 = this.calculateEMA(closes, 50);
    const rsi = this.calculateRSI(closes, 14);
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const currentVolume = volumes[volumes.length - 1];

    let trend: TimeframeAnalysis['trend'] = 'NEUTRAL';
    let momentum: TimeframeAnalysis['momentum'] = 'NEUTRAL';
    let volumeProfile: TimeframeAnalysis['volumeProfile'] = 'NORMAL';
    let emaCross: TimeframeAnalysis['emaCross'] = 'NONE';
    const reasoning: string[] = [];

    if (ema20 > ema50) {
      trend = 'BULLISH';
      emaCross = 'GOLDEN';
      reasoning.push('EMA 20 > EMA 50');
    } else if (ema20 < ema50) {
      trend = 'BEARISH';
      emaCross = 'DEATH';
      reasoning.push('EMA 20 < EMA 50');
    }

    if (rsi > 70) {
      momentum = 'OVERBOUGHT';
      reasoning.push(`RSI ${rsi.toFixed(1)} > 70`);
    } else if (rsi < 30) {
      momentum = 'OVERSOLD';
      reasoning.push(`RSI ${rsi.toFixed(1)} < 30`);
    } else if (rsi > 60) {
      reasoning.push(`RSI ${rsi.toFixed(1)} bullish`);
    } else if (rsi < 40) {
      reasoning.push(`RSI ${rsi.toFixed(1)} bearish`);
    }

    if (currentVolume > avgVolume * 1.5) {
      volumeProfile = 'HIGH';
      reasoning.push('Volume spike');
    } else if (currentVolume < avgVolume * 0.5) {
      volumeProfile = 'LOW';
      reasoning.push('Low volume');
    }

    const lastClose = closes[closes.length - 1];
    const highestHigh = Math.max(...highs.slice(-20));
    const lowestLow = Math.min(...lows.slice(-20));
    const rangePosition = (highestHigh - lowestLow) > 0 ? (lastClose - lowestLow) / (highestHigh - lowestLow) : 0.5;

    let confidence = 0;
    if (trend === 'BULLISH') confidence += 30;
    if (trend === 'BEARISH') confidence += 30;
    if (momentum === 'OVERSOLD' && trend === 'BULLISH') confidence += 25;
    if (momentum === 'OVERBOUGHT' && trend === 'BEARISH') confidence += 25;
    if (volumeProfile === 'HIGH') confidence += 15;
    if (emaCross !== 'NONE') confidence += 10;
    confidence = Math.min(100, Math.max(0, confidence));

    if (strategy === 'scalping' && confidence < 40) confidence = Math.max(0, confidence - 10);
    if (strategy === 'breakout' && rangePosition < 0.9 && trend === 'BULLISH') confidence = Math.max(0, confidence - 5);

    return {
      trend,
      momentum,
      volumeProfile,
      emaCross,
      rsi,
      confidence,
      reasoning,
    };
  }

  private calculateEMA(closes: number[], period: number): number {
    if (closes.length < period) return closes[closes.length - 1] || 0;
    const multiplier = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * multiplier + ema;
    }
    return ema;
  }

  private calculateRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

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

      const user = await this.env.DB.prepare(
        'SELECT exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?'
      ).bind(userId).first<{ exchange_name: string; exchange_environment: string | null; exchange_region: string | null }>();

      if (!user?.exchange_name) return;

      const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment), normalizeRegion(user.exchange_region));

      for (const position of results as any[]) {
        try {
          const ticker = await adapter.fetchTicker(position.symbol);
          if (!ticker) continue;

          const currentPrice = ticker.price;
          let closeReason: string | null = null;

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
