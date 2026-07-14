import { Env } from './index';
import { getExchangeAdapter, ExchangeName, ExchangeEnvironment, MarketTicker } from './exchanges';
import { decrypt } from './crypto';

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
        await this.state.storage.setAlarm(Date.now() + 60000);
        return new Response(JSON.stringify({ success: true, message: 'Bot activated.' }), { status: 200 });
      }
      case '/deactivate': {
        await this.state.storage.put('isActive', false);
        try { await this.state.storage.deleteAlarm(); } catch (e) { /* ignore */ }
        return new Response(JSON.stringify({ success: true, message: 'Bot deactivated.' }), { status: 200 });
      }
      case '/status': {
        const isActive = (await this.state.storage.get('isActive')) || false;
        const coinId = (await this.state.storage.get('coinId')) || null;
        const strategy = (await this.state.storage.get('strategy')) || null;
        return new Response(JSON.stringify({ isActive, coinId, strategy }), { status: 200 });
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
      }
    } catch (e) {
      console.error('Monitoring cycle error:', e);
    }
  }

  private pruneAlerts(alerts: TradeAlert[]): TradeAlert[] {
    // Keep only actionable (pending) alerts and cap the retained history to
    // avoid unbounded growth of the Durable Object's storage.
    const pending = alerts.filter(a => a.status === 'pending');
    return pending.slice(-100);
  }

  private detectOpportunity(ticker: MarketTicker, strategy: string): { symbol: string; entryPrice: number; stopLoss: number; takeProfit: number; estimatedPnl: number; side: 'BUY' | 'SELL' } | null {
    const change = ticker.priceChangePercent24h;
    const price = ticker.price;

    if (Math.abs(change) < 1.5) return null;

    const isBullish = change > 0;
    const side: 'BUY' | 'SELL' = isBullish ? 'BUY' : 'SELL';
    let entryPrice = price;
    let stopLoss = price;
    let takeProfit = price;

    switch (strategy) {
      case "scalping":
        entryPrice = price;
        stopLoss = isBullish ? price * 0.995 : price * 1.005;
        takeProfit = isBullish ? price * 1.01 : price * 0.99;
        break;
      case "momentum":
        entryPrice = price;
        stopLoss = isBullish ? price * 0.98 : price * 1.02;
        takeProfit = isBullish ? price * 1.04 : price * 0.96;
        break;
      case "breakout":
        entryPrice = price;
        stopLoss = isBullish ? price * 0.985 : price * 1.015;
        takeProfit = isBullish ? price * 1.03 : price * 0.97;
        break;
      case "mean_reversion":
        entryPrice = price;
        stopLoss = isBullish ? price * 0.98 : price * 1.02;
        takeProfit = isBullish ? price * 1.015 : price * 0.985;
        break;
      case "vwap":
        entryPrice = price;
        stopLoss = isBullish ? price * 0.99 : price * 1.01;
        takeProfit = isBullish ? price * 1.02 : price * 0.98;
        break;
      default:
        entryPrice = price;
        stopLoss = isBullish ? price * 0.99 : price * 1.01;
        takeProfit = isBullish ? price * 1.02 : price * 0.98;
        break;
    }

    const estimatedPnl = Math.abs((takeProfit - entryPrice) / entryPrice) * ticker.minNotional;

    return {
      symbol: ticker.symbol,
      entryPrice,
      stopLoss,
      takeProfit,
      estimatedPnl,
      side,
    };
  }
}
