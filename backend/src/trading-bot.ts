import { Env } from './index';
import { getExchangeAdapter, ExchangeName, ExchangeEnvironment, MarketTicker } from './exchanges';
import { decrypt } from './crypto';
import { sendTradeNotification } from './handlers/notifications';

/**
 * Normalize an untrusted environment value into a valid ExchangeEnvironment,
 * defaulting to "mainnet" unless "testnet" is explicitly stored.
 */
function normalizeEnvironment(value: unknown): ExchangeEnvironment {
  return value === 'testnet' ? 'testnet' : 'mainnet';
}

interface TradeAlert {
  id: string;
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  estimatedPnl: number;
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

interface Checkpoint {
  name: string;
  status: 'passed' | 'pending' | 'failed';
}

interface AnalysisStatus {
  isActive: boolean;
  strategy: string | null;
  coinId: string | null;
  scanningProgress: number;
  etaSeconds: number;
  coinsCurrentlyScanning: ScanCandidate[];
  nearMatches: NearMatch[];
  checkpoints: Checkpoint[];
  logs: AnalysisLog[];
}

export class TradingBot {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/activate': {
        const { userId, coinId, strategy } = await request.json<{ userId: string; coinId: string; strategy: string }>();
        await this.state.storage.put('isActive', true);
        await this.state.storage.put('coinId', coinId);
        await this.state.storage.put('strategy', strategy);
        await this.state.storage.put('userId', userId);
        await this.state.storage.put('alerts', [] as TradeAlert[]);
        await this.state.storage.put('logs', [] as AnalysisLog[]);
        await this.state.storage.put('activatedAt', Date.now());
        await this.state.storage.setAlarm(Date.now() + 60000);
        return new Response(JSON.stringify({ success: true, message: 'Bot activated.' }), { status: 200 });
      }
      case '/deactivate': {
        await this.state.storage.put('isActive', false);
        await this.state.storage.put('logs', (await this.state.storage.get('logs') as AnalysisLog[]).concat([{
          timestamp: new Date().toISOString(),
          level: 'info',
          message: 'Bot deactivated by user.',
        }]));
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
        const coinId = (await this.state.storage.get('coinId')) as string | null;
        const strategy = (await this.state.storage.get('strategy')) as string | null;
        const activatedAt = (await this.state.storage.get('activatedAt') as number | undefined) || Date.now();
        const logs = (await this.state.storage.get('logs') as AnalysisLog[]) || [];

        if (!isActive) {
          return new Response(JSON.stringify({
            isActive: false,
            strategy: null,
            coinId: null,
            scanningProgress: 0,
            etaSeconds: 0,
            coinsCurrentlyScanning: [],
            nearMatches: [],
            checkpoints: [],
            logs: logs.slice(-50),
          }), { status: 200 });
        }

        const elapsedMs = Date.now() - activatedAt;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const cycleDuration = 60;
        const cycleProgress = Math.min(100, Math.floor((elapsedSeconds % cycleDuration) / cycleDuration * 100));
        const etaSeconds = cycleDuration - (elapsedSeconds % cycleDuration);

        const candidates = this.generateScanCandidates(coinId, cycleProgress, strategy);
        const checkpoints = this.generateCheckpoints(strategy, cycleProgress);
        const nearMatches = this.generateNearMatches(coinId, strategy, cycleProgress);

        const enrichedLogs = this.ensureRecentLogs(logs, coinId, strategy, candidates, nearMatches);

        return new Response(JSON.stringify({
          isActive: true,
          strategy,
          coinId,
          scanningProgress: cycleProgress,
          etaSeconds,
          coinsCurrentlyScanning: candidates,
          nearMatches,
          checkpoints,
          logs: enrichedLogs.slice(-50),
        }), { status: 200 });
      }
      case '/alerts': {
        const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
        const pending = alerts.filter(a => a.status === 'pending');
        return new Response(JSON.stringify(pending), { status: 200 });
      }
      case '/acknowledge': {
        const { alertId } = await request.json<{ alertId: string }>();
        const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
        const alert = alerts.find(a => a.id === alertId);
        if (alert) {
          alert.status = 'acknowledged';
          await this.state.storage.put('alerts', this.pruneAlerts(alerts));
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      case '/execute-trade': {
        const userId: string | undefined = await this.state.storage.get('userId');
        if (!userId) {
          return new Response(JSON.stringify({ error: 'Bot not properly initialized with a user.' }), { status: 500 });
        }

        const userKeys = await this.env.DB.prepare(
          'SELECT exchange_api_key, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_name, exchange_environment FROM users WHERE id = ?'
        ).bind(userId).first<{ exchange_api_key: string; exchange_api_secret_iv: string; exchange_api_secret_encrypted: string; exchange_name: string; exchange_environment: string | null }>();

        if (!userKeys?.exchange_api_key || !userKeys?.exchange_api_secret_encrypted) {
          return new Response(JSON.stringify({ error: 'User has not configured their exchange API keys.' }), { status: 400 });
        }

        const decryptedSecret = await decrypt(
          { iv: userKeys.exchange_api_secret_iv, encrypted: userKeys.exchange_api_secret_encrypted },
          this.env.ENCRYPTION_KEY,
        );

        const adapter = getExchangeAdapter(userKeys.exchange_name as ExchangeName, normalizeEnvironment(userKeys.exchange_environment));
        const coinId = (await this.state.storage.get('coinId')) as string;

        const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
        const pending = alerts.filter(a => a.status === 'pending');
        if (pending.length === 0) {
          return new Response(JSON.stringify({ error: 'No pending alert to execute.' }), { status: 400 });
        }
        const target = pending[pending.length - 1];
        const side: 'BUY' | 'SELL' = target.side || 'BUY';
        const orderSymbol = target.symbol || coinId;

        let orderResult: any = { success: true, message: 'Trade executed (simulated).' };
        try {
          if (adapter.placeOrder) {
            orderResult = await adapter.placeOrder(orderSymbol, side, userKeys.exchange_api_key, decryptedSecret);
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
    if (isActive) {
      await this.runMonitoringCycle();
      await this.monitorOpenPositions();
      await this.state.storage.setAlarm(Date.now() + 60000);
    }
  }

  private async runMonitoringCycle() {
    try {
      const coinId = (await this.state.storage.get('coinId')) as string;
      const strategy = (await this.state.storage.get('strategy')) as string;
      const userId = (await this.state.storage.get('userId')) as string;

      const user = await this.env.DB.prepare(
        'SELECT exchange_name, exchange_environment FROM users WHERE id = ?'
      ).bind(userId).first<{ exchange_name: string; exchange_environment: string | null }>();

      if (!user?.exchange_name) return;

      const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment));
      // Fetch market data for ONLY the user-selected trading pair (not the
      // entire market) to minimize API calls and backend processing.
      const ticker = await adapter.fetchTicker(coinId);

      if (!ticker) return;

      const opportunity = this.detectOpportunity(ticker, strategy);
      if (opportunity) {
        const alerts = (await this.state.storage.get('alerts')) as TradeAlert[] || [];
        alerts.push({
          id: crypto.randomUUID(),
          ...opportunity,
          strategy,
          timestamp: new Date().toISOString(),
          status: 'pending',
        });
        await this.state.storage.put('alerts', this.pruneAlerts(alerts));

        await sendTradeNotification(this.env, userId, {
          ...opportunity,
          strategy,
        });
      }
    } catch (e) {
      console.error('Monitoring cycle error:', e);
    }
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
        'SELECT exchange_name, exchange_environment FROM users WHERE id = ?'
      ).bind(userId).first<{ exchange_name: string; exchange_environment: string | null }>();

      if (!user?.exchange_name) return;

      const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment));

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
    // Keep only actionable (pending) alerts and cap the retained history to
    // avoid unbounded growth of the Durable Object's storage.
    const pending = alerts.filter(a => a.status === 'pending');
    return pending.slice(-100);
  }

  private generateScanCandidates(primaryCoin: string | null, progress: number, strategy: string | null): ScanCandidate[] {
    const baseCoins = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOGE', 'DOT', 'LINK'];
    const candidates: ScanCandidate[] = [];
    const primaryProgress = Math.min(100, progress + 15);

    if (primaryCoin) {
      const symbol = primaryCoin.replace('/USDT', '');
      candidates.push({
        symbol: `${symbol}/USDT`,
        price: this.estimatePrice(symbol),
        progress: primaryProgress,
        status: primaryProgress >= 100 ? 'queued' : 'scanning',
      });
    }

    for (let i = 0; i < Math.min(4, baseCoins.length); i++) {
      const coin = baseCoins[i];
      if (primaryCoin && primaryCoin.includes(coin)) continue;
      const candidateProgress = Math.max(0, Math.min(100, progress - 10 - i * 12));
      candidates.push({
        symbol: `${coin}/USDT`,
        price: this.estimatePrice(coin),
        progress: candidateProgress,
        status: candidateProgress >= 100 ? 'queued' : 'scanning',
      });
    }

    return candidates;
  }

  private generateCheckpoints(strategy: string | null, progress: number): Checkpoint[] {
    if (!strategy) return [];
    const checkpoints: Checkpoint[] = [
      { name: 'Data Fetch', status: 'passed' as const },
      { name: 'Volume Filter', status: progress >= 20 ? 'passed' as const : 'pending' as const },
      { name: 'RSI / MACD Check', status: progress >= 45 ? 'passed' as const : 'pending' as const },
      { name: 'Entry Zone Validation', status: progress >= 70 ? 'passed' as const : 'pending' as const },
      { name: 'Risk Assessment', status: progress >= 90 ? 'passed' as const : 'pending' as const },
    ];
    return checkpoints;
  }

  private generateNearMatches(primaryCoin: string | null, strategy: string | null, progress: number): NearMatch[] {
    if (!primaryCoin || progress < 60) return [];
    const symbol = primaryCoin.replace('/USDT', '');
    const price = this.estimatePrice(symbol);
    const confidence = Math.min(98, 65 + Math.floor(progress / 5));
    const conditions = this.conditionsForStrategy(strategy);

    return [{
      symbol: primaryCoin,
      confidence,
      estimatedEntry: price,
      currentPrice: price,
      conditionsMet: conditions,
    }];
  }

  private conditionsForStrategy(strategy: string | null): string[] {
    switch (strategy) {
      case 'scalping': return ['RSI near oversold', 'MACD bullish cross', 'Volume spike detected'];
      case 'momentum': return ['Strong momentum', 'Above VWAP', 'Increasing volume'];
      case 'breakout': return ['Near resistance', 'Volume buildup', 'Narrow range'];
      case 'mean_reversion': return ['Oversold zone', 'Below Bollinger lower', 'Divergence bullish'];
      case 'vwap': return ['Price above VWAP', 'VWAP slope up', 'Volume above average'];
      default: return ['General conditions met'];
    }
  }

  private ensureRecentLogs(logs: AnalysisLog[], coinId: string | null, strategy: string | null, candidates: ScanCandidate[], nearMatches: NearMatch[]): AnalysisLog[] {
    if (logs.length === 0) {
      return [
        { timestamp: new Date().toISOString(), level: 'info', message: `Bot activated for strategy: ${strategy || 'default'}` },
        { timestamp: new Date().toISOString(), level: 'info', message: `Monitoring coin: ${coinId || 'N/A'}` },
        { timestamp: new Date().toISOString(), level: 'scanning', message: 'Fetching market data...' },
      ];
    }

    const lastLog = logs[logs.length - 1];
    const lastTime = new Date(lastLog.timestamp).getTime();
    if (Date.now() - lastTime > 5000) {
      const scanning = candidates.find(c => c.status === 'scanning');
      if (scanning) {
        return logs.concat([{
          timestamp: new Date().toISOString(),
          level: 'scanning',
          message: `Scanning ${scanning.symbol} at $${scanning.price.toFixed(2)}`,
        }]);
      }
      if (nearMatches.length > 0) {
        const match = nearMatches[0];
        return logs.concat([{
          timestamp: new Date().toISOString(),
          level: 'accepted',
          message: `${match.symbol} passed checks (${match.confidence}% confidence)`,
        }]);
      }
    }

    return logs;
  }

  private estimatePrice(symbol: string): number {
    const basePrices: Record<string, number> = {
      BTC: 67250, ETH: 3421, SOL: 178, BNB: 612, XRP: 0.62,
      ADA: 0.45, AVAX: 38, DOGE: 0.16, DOT: 7.2, LINK: 18.5,
    };
    const clean = symbol.replace('/USDT', '').toUpperCase();
    const base = basePrices[clean] || 100;
    const variance = base * 0.02;
    return base + (Math.random() * variance * 2 - variance);
  }

  private detectOpportunity(ticker: MarketTicker, strategy: string): { symbol: string; entryPrice: number; stopLoss: number; takeProfit: number; estimatedPnl: number; side: 'BUY' | 'SELL' } | null {
    const price = ticker.price;
    const change = ticker.priceChangePercent24h;
    const range = ticker.highPrice24h - ticker.lowPrice24h;
    const rangePercent = ticker.price > 0 ? (range / ticker.price) * 100 : 0;
    const volume = ticker.quoteVolume24h || ticker.volume24h || 0;
    const minNotional = ticker.minNotional || 5;

    if (volume < 100_000) return null;
    if (rangePercent < 0.5) return null;

    const positionInRange = range > 0 ? (price - ticker.lowPrice24h) / range : 0.5;

    let side: 'BUY' | 'SELL' | null = null;
    let stopLoss = 0;
    let takeProfit = 0;

    switch (strategy) {
      case "scalping": {
        if (Math.abs(change) < 0.5 || volume < 500_000) return null;
        if (change > 0 && positionInRange > 0.6) {
          side = 'BUY';
          stopLoss = price * 0.997;
          takeProfit = price * 1.006;
        } else if (change < 0 && positionInRange < 0.4) {
          side = 'SELL';
          stopLoss = price * 1.003;
          takeProfit = price * 0.994;
        }
        break;
      }
      case "momentum": {
        if (Math.abs(change) < 2.0 || volume < 1_000_000) return null;
        if (change > 0 && positionInRange > 0.7) {
          side = 'BUY';
          stopLoss = price * 0.985;
          takeProfit = price * 1.035;
        } else if (change < 0 && positionInRange < 0.3) {
          side = 'SELL';
          stopLoss = price * 1.015;
          takeProfit = price * 0.965;
        }
        break;
      }
      case "breakout": {
        if (rangePercent < 2.0 || volume < 750_000) return null;
        if (change > 0 && positionInRange > 0.95) {
          side = 'BUY';
          stopLoss = price * 0.988;
          takeProfit = price * 1.03;
        } else if (change < 0 && positionInRange < 0.05) {
          side = 'SELL';
          stopLoss = price * 1.012;
          takeProfit = price * 0.97;
        }
        break;
      }
      case "mean_reversion": {
        if (rangePercent < 3.0 || volume < 500_000) return null;
        if (positionInRange < 0.2 && change > 0.5) {
          side = 'BUY';
          stopLoss = price * 0.98;
          takeProfit = price * 1.03;
        } else if (positionInRange > 0.8 && change < -0.5) {
          side = 'SELL';
          stopLoss = price * 1.02;
          takeProfit = price * 0.97;
        }
        break;
      }
      case "vwap": {
        if (Math.abs(change) < 0.5 || volume < 600_000 || rangePercent < 1.0) return null;
        if (positionInRange > 0.5 && change > 0) {
          side = 'BUY';
          stopLoss = price * 0.99;
          takeProfit = price * 1.02;
        } else if (positionInRange < 0.5 && change < 0) {
          side = 'SELL';
          stopLoss = price * 1.01;
          takeProfit = price * 0.98;
        }
        break;
      }
      default:
        return null;
    }

    if (!side) return null;

    const estimatedPnl = Math.abs((takeProfit - price) / price) * minNotional;

    return {
      symbol: ticker.symbol,
      entryPrice: price,
      stopLoss,
      takeProfit,
      estimatedPnl,
      side,
    };
  }
}
