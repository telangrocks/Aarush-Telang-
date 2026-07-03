import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { cache } from 'hono/cache';
import { handleRegister, handleVerifyOtp, handleLogin, handleGetProfile } from './handlers/user';
import { handleGetMarketCandidates } from './handlers/market';
import { sendPriceAlertEmail } from './handlers/notification';
import { encrypt } from './crypto';
import { TradingBot } from './trading-bot';

export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  JWT_SECRET: string;
  PRICE_CACHE: KVNamespace;
  TRADING_BOTS: DurableObjectNamespace;
  ENCRYPTION_KEY: string; // Secret key for encrypting API secrets
  __VITEST_POOL_ID__?: string; // Used by vitest
}

interface CoinGeckoMarket {
  id: string;
  name: string;
  symbol: string;
  current_price: number;
  price_change_percentage_24h: number;
}

interface AlertWithUser {
  id: string;
  user_id: string;
  token_id: string;
  target_price: number;
  condition: 'ABOVE' | 'BELOW';
  email: string;
}

interface JWTPayload {
  sub: string;
  email: string;
  exp: number;
}

const app = new Hono<{ Bindings: Env }>();


// Global error handler
app.onError((err: Error, c) => {
  console.error(err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'Crypto Pulse Backend',
    timestamp: new Date().toISOString()
  });
});

// Database status endpoint
app.get('/db-status', async (c) => {
  try {
    // Check if we can query the database
    await c.env.DB.prepare('SELECT 1').run();
    return c.json({
      status: 'ok',
      message: 'Database connection successful',
      timestamp: new Date().toISOString()
    });
  } catch (err: unknown) {
    const error = err as Error;
    return c.json({
      status: 'error',
      message: 'Database connection failed',
      error: error.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// --- User Onboarding Endpoints ---
app.post('/api/register', (c) => handleRegister(c));
app.post('/api/verify-otp', (c) => handleVerifyOtp(c));
app.post('/api/login', (c) => handleLogin(c));

// --- Protected API Routes ---
const api = new Hono<{ Bindings: Env }>();

api.use('/*', (c, next) => {
  const auth = jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' });
  return auth(c, next);
});
api.get('/profile', (c) => handleGetProfile(c));
app.route('/api', api);

// --- Watchlist Endpoints (Protected) ---
api.get('/watchlist', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const { results } = await c.env.DB.prepare('SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC').bind(payload.sub).all();
  return c.json(results);
});

api.post('/watchlist', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const body = await c.req.json();
  const { token_id } = body;
  if (!token_id) {
    return c.json({ error: 'token_id is required' }, 400);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO watchlist (id, user_id, token_id, added_at) VALUES (?, ?, ?, ?)').bind(id, payload.sub, token_id, new Date().toISOString()).run();
  return c.json({ success: true, id, token_id });
});

api.delete('/watchlist/:id', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload;
    const id = c.req.param('id');
    const { success } = await c.env.DB.prepare('DELETE FROM watchlist WHERE id = ? AND user_id = ?').bind(id, payload.sub).run();
    return c.json({ success });
});

// --- Portfolio Endpoints (Protected) ---
api.get('/portfolio', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload;
    const { results } = await c.env.DB.prepare('SELECT * FROM portfolio_transactions WHERE user_id = ? ORDER BY transaction_date DESC').bind(payload.sub).all();
    return c.json(results);
});

api.post('/portfolio', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload;
    const body = await c.req.json();
    const { token_id, amount, buy_price } = body;
    if (!token_id || amount === undefined || buy_price === undefined) {
        return c.json({ error: 'token_id, amount, and buy_price are required' }, 400);
    }
    const id = crypto.randomUUID();
    await c.env.DB.prepare('INSERT INTO portfolio_transactions (id, user_id, token_id, amount, buy_price, transaction_date) VALUES (?, ?, ?, ?, ?, ?)').bind(id, payload.sub, token_id, amount, buy_price, new Date().toISOString()).run();
    return c.json({ success: true, id, token_id, amount, buy_price });
});

api.delete('/portfolio/:id', async (c) => {
    const payload = c.get('jwtPayload') as JWTPayload;
    const id = c.req.param('id');
    const { success } = await c.env.DB.prepare('DELETE FROM portfolio_transactions WHERE id = ? AND user_id = ?').bind(id, payload.sub).run();
    return c.json({ success });
});

// --- Price Alert Endpoints (Protected) ---
api.get('/alerts', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const { results } = await c.env.DB.prepare('SELECT * FROM price_alerts WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC').bind(payload.sub).all();
  return c.json(results);
});

api.post('/alerts', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const body = await c.req.json();
  const { token_id, target_price, condition } = body;
  if (!token_id || target_price === undefined || !['ABOVE', 'BELOW'].includes(condition)) {
    return c.json({ error: 'token_id, target_price, and a valid condition (ABOVE/BELOW) are required' }, 400);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO price_alerts (id, user_id, token_id, target_price, condition, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, payload.sub, token_id, target_price, condition, new Date().toISOString()).run();
  return c.json({ success: true, id, token_id, target_price, condition });
});

api.delete('/alerts/:id', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const id = c.req.param('id');
  const { success } = await c.env.DB.prepare('DELETE FROM price_alerts WHERE id = ? AND user_id = ?').bind(id, payload.sub).run();
  return c.json({ success });
});

// --- Exchange API Key Management (Protected) ---
api.post('/exchange/keys', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const { apiKey, apiSecret } = await c.req.json<{ apiKey: string; apiSecret: string }>();

  if (!apiKey || !apiSecret) {
    return c.json({ error: 'apiKey and apiSecret are required' }, 400);
  }

  // Encrypt the secret before storing
  const { iv, encrypted } = await encrypt(apiSecret, c.env.ENCRYPTION_KEY);

  await c.env.DB.prepare(
    'UPDATE users SET exchange_api_key = ?, exchange_api_secret_iv = ?, exchange_api_secret_encrypted = ? WHERE id = ?'
  ).bind(apiKey, iv, encrypted, payload.sub).run();

  return c.json({ success: true, message: 'API keys stored securely.' });
});

// --- AI Engine & Bot Management Endpoints (Protected) ---

// This endpoint now uses a real analysis handler and is cached for 5 minutes.
api.get(
  '/market/candidates',
  cache({
    cacheName: 'market-candidates-cache',
    cacheControl: 'max-age=300', // 5 minutes
  }),
  (c) => handleGetMarketCandidates(c)
);

// Executes a trade based on the bot's current setup.
api.post('/bot/execute-trade', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const doId = c.env.TRADING_BOTS.idFromName(payload.sub);
  const stub = c.env.TRADING_BOTS.get(doId);
  return stub.fetch(new Request(new URL(c.req.url).origin + '/execute-trade', { method: 'POST' }));
});

// Manually stops an active trade.
api.post('/bot/stop-trade', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const doId = c.env.TRADING_BOTS.idFromName(payload.sub);
  const stub = c.env.TRADING_BOTS.get(doId);
  return stub.fetch(new Request(new URL(c.req.url).origin + '/stop-trade', { method: 'POST' }));
});

// This endpoint provides the list of available strategies.
api.get('/strategies', (c) => {
  return c.json([
    { id: 'strategy_1', name: 'Momentum Master', description: 'Follows strong market trends.' },
    { id: 'strategy_2', name: 'Volatility Scalper', description: 'Capitalizes on small price fluctuations.' },
    { id: 'strategy_3', name: 'Mean Reversion', description: 'Bets on prices returning to their average.' },
    { id: 'strategy_4', name: 'Support & Resistance', description: 'Trades based on key price levels.' },
    { id: 'strategy_5', name: 'AI Adaptive', description: 'A dynamic strategy that adapts to market conditions.' },
  ]);
});

// Activates the trading bot for the user.
api.post('/bot/activate', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const { coinId, strategy } = await c.req.json();
  const doId = c.env.TRADING_BOTS.idFromName(payload.sub); // Use user ID as the DO name
  const stub = c.env.TRADING_BOTS.get(doId);
  // Pass userId in the body to the DO for storage
  return stub.fetch(new Request(new URL(c.req.url).origin + '/activate', { method: 'POST', body: JSON.stringify({ userId: payload.sub, coinId, strategy }) }));
});

// Deactivates the trading bot.
api.post('/bot/deactivate', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const doId = c.env.TRADING_BOTS.idFromName(payload.sub);
  const stub = c.env.TRADING_BOTS.get(doId);
  return stub.fetch(new Request(new URL(c.req.url).origin + '/deactivate', { method: 'POST' }));
});

// Gets the current status of the user's bot.
api.get('/bot/status', async (c) => {
  const payload = c.get('jwtPayload') as JWTPayload;
  const doId = c.env.TRADING_BOTS.idFromName(payload.sub);
  const stub = c.env.TRADING_BOTS.get(doId);
  return stub.fetch(new Request(new URL(c.req.url).origin + '/status'));
});

// ------------------------------------

// GET /api/prices
app.get(
  '/api/prices',
  cache({
    cacheName: 'crypto-pulse-cache',
    cacheControl: 'max-age=60', // Cache for 60 seconds
    keyGenerator: (c) => `prices:${c.req.query('vs_currency') || 'usd'}`,
  }),
  async (c) => {
    try {
      // Fetch data from CoinGecko API
      const response = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&sparkline=false');
      if (!response.ok) {
        return c.json({ error: 'Failed to fetch prices from external API' }, { status: response.status });
      }
      const data: CoinGeckoMarket[] = await response.json();
      const formattedData = data.map((coin) => ({
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol,
        price: coin.current_price,
        change_24h: coin.price_change_percentage_24h,
      }));
      return c.json({ timestamp: new Date().toISOString(), data: formattedData });
    } catch (err: unknown) {
      const error = err as Error;
      return c.json({ error: 'Error fetching prices', message: error.message }, 500);
    }
  }
);

// GET /api/news
app.get('/api/news', (c) => {
  return c.json([
    {
      id: '1',
      title: 'Bitcoin Holds Support at $65,000 as Market Consolidates',
      source: 'CryptoNews',
      url: 'https://example.com/news/1',
      published_at: new Date().toISOString()
    },
    {
      id: '2',
      title: 'Ethereum Layer 2 Activity Reaches Record Highs',
      source: 'EtherPulse',
      url: 'https://example.com/news/2',
      published_at: new Date().toISOString()
    }
  ]);
});

async function processAlerts(env: Env) {
  console.log('Starting alert processing...');
  const { results: alerts } = await env.DB.prepare("SELECT pa.id, pa.user_id, pa.token_id, pa.target_price, pa.condition, u.email FROM price_alerts pa JOIN users u ON pa.user_id = u.id WHERE pa.is_active = 1").all<AlertWithUser>();
  if (!alerts || alerts.length === 0) {
    console.log('No active alerts to process.');
    return;
  }

  const tokenIds = [...new Set(alerts.map(a => a.token_id))];
  const priceResponse = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${tokenIds.join(',')}&vs_currencies=usd`);
  if (!priceResponse.ok) {
    console.error('Failed to fetch prices for alert processing.');
    return;
  }
  const prices = await priceResponse.json<Record<string, { usd: number }>>();

  for (const alert of alerts) {
    const currentPrice = prices[alert.token_id]?.usd;
    if (currentPrice === undefined) continue;

    const conditionMet = (alert.condition === 'ABOVE' && currentPrice >= alert.target_price) || (alert.condition === 'BELOW' && currentPrice <= alert.target_price);

    if (conditionMet) {
      console.log(`Alert triggered for user ${alert.user_id} on token ${alert.token_id}`);
      
      // Send notification
      await sendPriceAlertEmail(
        alert.email,
        { tokenId: alert.token_id, targetPrice: alert.target_price, condition: alert.condition, currentPrice },
        env.RESEND_API_KEY
      );

      // Deactivate alert
      await env.DB.prepare("UPDATE price_alerts SET is_active = 0, triggered_at = ? WHERE id = ?").bind(new Date().toISOString(), alert.id).run();
    }
  }
  console.log('Finished alert processing.');
}

export default {
  fetch: app.fetch.bind(app),
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // This function is called by the cron trigger in wrangler.toml
    // Example wrangler.toml configuration:
    // [triggers]
    // crons = ["* * * * *"] # Every minute
    ctx.waitUntil(processAlerts(env));
  },
};

// Export the Durable Object class
export { TradingBot };
