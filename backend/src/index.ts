import { Hono } from 'hono';
import { jwt } from '@hono/jwt';
import { handleRegister, handleVerifyOtp, handleLogin, handleGetProfile } from './handlers/user';

export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  JWT_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();


// Global error handler
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'Crypto Pulse Backend',
    timestamp: new Date().toISOString()
  });
});

// --- User Onboarding Endpoints ---
app.post('/api/register', async (c) => handleRegister(c.req.raw, c.env));
app.post('/api/verify-otp', async (c) => handleVerifyOtp(c.req.raw, c.env));
app.post('/api/login', async (c) => handleLogin(c.req.raw, c.env));

// --- Protected API Routes ---
const api = new Hono<{ Bindings: Env }>();

api.use('/*', (c, next) => {
  const auth = jwt({ secret: c.env.JWT_SECRET });
  return auth(c, next);
});
api.get('/profile', (c) => handleGetProfile(c));
app.route('/api', api);
// ------------------------------------

// GET /api/prices
app.get('/api/prices', (c) => {
  // TODO: Integrate CoinGecko or another public API
  return c.json({
    timestamp: new Date().toISOString(),
    data: [
      { id: 'bitcoin', name: 'Bitcoin', symbol: 'btc', price: 65230.50, change_24h: 1.25 },
      { id: 'ethereum', name: 'Ethereum', symbol: 'eth', price: 3450.75, change_24h: -0.45 },
      { id: 'solana', name: 'Solana', symbol: 'sol', price: 135.20, change_24h: 4.80 }
    ]
  });
});

// GET /api/watchlist
app.get('/api/watchlist', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM watchlist ORDER BY added_at DESC'
    ).all();
    return c.json(results);
  } catch (err: any) {
    return c.json({ error: 'Database error', message: err.message }, 500);
  }
});

// POST /api/watchlist
app.post('/api/watchlist', async (c) => {
  try {
    const body = await c.req.json();
    const { token_id } = body;
    if (!token_id) {
      return c.json({ error: 'token_id is required' }, 400);
    }
    
    await c.env.DB.prepare(
      'INSERT INTO watchlist (token_id, added_at) VALUES (?, ?)'
    ).bind(token_id, new Date().toISOString()).run();
    
    return c.json({ success: true, token_id });
  } catch (err: any) {
    return c.json({ error: 'Database error', message: err.message }, 500);
  }
});

// GET /api/portfolio
app.get('/api/portfolio', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM portfolio ORDER BY date DESC'
    ).all();
    return c.json(results);
  } catch (err: any) {
    return c.json({ error: 'Database error', message: err.message }, 500);
  }
});

// POST /api/portfolio
app.post('/api/portfolio', async (c) => {
  try {
    const body = await c.req.json();
    const { token_id, amount, buy_price } = body;
    if (!token_id || amount === undefined || buy_price === undefined) {
      return c.json({ error: 'token_id, amount, and buy_price are required' }, 400);
    }
    
    await c.env.DB.prepare(
      'INSERT INTO portfolio (token_id, amount, buy_price, date) VALUES (?, ?, ?, ?)'
    ).bind(token_id, amount, buy_price, new Date().toISOString()).run();
    
    return c.json({ success: true, token_id, amount, buy_price });
  } catch (err: any) {
    return c.json({ error: 'Database error', message: err.message }, 500);
  }
});

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

export default app;
